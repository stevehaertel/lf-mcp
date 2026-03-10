#!/usr/bin/env node

/**
 * Langflow MCP Server (SSE Transport)
 * Exposes MCP tools via HTTP/SSE for remote hosting
 */

import express from 'express';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Get configuration from environment variables
const {
  PORT = 3000,
  MCP_API_KEY,
  DATASTAX_LANGFLOW_URL,
  LANGFLOW_TENANT_ID,
  FLOW_ID,
  ASTRA_ORG_ID,
  APPLICATION_TOKEN
} = process.env;

// Validate required environment variables
if (!MCP_API_KEY) {
  throw new Error('MCP_API_KEY environment variable is required');
}
if (!DATASTAX_LANGFLOW_URL) {
  throw new Error('DATASTAX_LANGFLOW_URL environment variable is required');
}
if (!LANGFLOW_TENANT_ID) {
  throw new Error('LANGFLOW_TENANT_ID environment variable is required');
}
if (!FLOW_ID) {
  throw new Error('FLOW_ID environment variable is required');
}
if (!ASTRA_ORG_ID) {
  throw new Error('ASTRA_ORG_ID environment variable is required');
}
if (!APPLICATION_TOKEN) {
  throw new Error('APPLICATION_TOKEN environment variable is required');
}

// Create Express app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'langflow-mcp-server' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Langflow MCP Server',
    version: '1.0.0',
    transport: 'SSE',
    endpoints: {
      health: '/health',
      sse: '/sse (GET with x-api-key header)',
      message: '/message (POST with x-api-key header)'
    }
  });
});

// Create a single MCP server instance
const mcpServer = new Server(
  {
    name: "langflow-agent",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register list tools handler
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query_technology_sales_revenue",
        description: "Query and analyze revenue data from technology sales. This tool provides insights into sales performance, revenue trends, customer segments, product categories, and financial metrics for technology products and services. Use this tool to answer questions about sales figures, revenue analysis, customer behavior, and business performance in the technology sector.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Your question about technology sales revenue. Examples: 'What is the revenue at risk for today?', 'Show me revenue by product category', 'Which customers have the highest revenue?', 'What are the revenue trends over time?'",
            },
            session_id: {
              type: "string",
              description: "Optional session ID to maintain conversation context across multiple queries",
            },
          },
          required: ["message"],
        },
      },
    ],
  };
});

// Register call tool handler
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "query_technology_sales_revenue") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { message, session_id } = request.params.arguments;

  try {
    // Build the Langflow API URL
    const url = `${DATASTAX_LANGFLOW_URL}/lf/${LANGFLOW_TENANT_ID}/api/v1/run/${FLOW_ID}`;
    
    console.log(`Querying Langflow: ${message.substring(0, 50)}...`);
    
    // Make the API request
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${APPLICATION_TOKEN}`,
        "X-DataStax-Current-Org": ASTRA_ORG_ID
      },
      body: JSON.stringify({
        input_value: message,
        input_type: "chat",
        output_type: "chat",
        ...(session_id ? { session_id } : {})
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { raw: errorText };
      }
      
      return {
        content: [
          {
            type: "text",
            text: `Langflow API error (${response.status}): ${JSON.stringify(errorData, null, 2)}`,
          },
        ],
        isError: true,
      };
    }

    // Parse the response
    const data = await response.json();
    
    // Extract the message from the response
    let agentResponse = "No response from agent";
    
    if (data.outputs && data.outputs.length > 0) {
      const output = data.outputs[0];
      if (output.outputs && output.outputs.length > 0) {
        const result = output.outputs[0];
        if (result.results && result.results.message) {
          const messageData = result.results.message;
          agentResponse = messageData.text || JSON.stringify(messageData);
        }
      }
    }
    
    console.log(`Response: ${agentResponse.substring(0, 100)}...`);
    
    return {
      content: [
        {
          type: "text",
          text: agentResponse,
        },
      ],
    };
    
  } catch (error) {
    console.error('Error querying Langflow:', error);
    return {
      content: [
        {
          type: "text",
          text: `Error querying Langflow agent: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Store active transports by session ID
const activeTransports = new Map();

// SSE endpoint (GET) - Establishes the SSE connection
app.get('/sse', async (req, res) => {
  console.log('[SSE] Incoming request to /sse');
  console.log('[SSE] Headers:', JSON.stringify(req.headers, null, 2));
  
  // Validate API key
  const apiKey = req.header('x-api-key');
  console.log('[SSE] API key received:', apiKey ? 'Yes' : 'No');
  
  if (!apiKey || apiKey.trim() !== MCP_API_KEY) {
    console.log('[SSE] Authentication failed');
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  console.log('[SSE] Authentication successful');
  console.log('[SSE] Creating SSE transport...');

  try {
    // Create SSE transport with the response object
    console.log('[SSE] Instantiating SSEServerTransport with endpoint: /message');
    const transport = new SSEServerTransport('/message', res);
    console.log('[SSE] Transport created with session ID:', transport.sessionId);
    
    // Store transport by session ID for routing messages
    activeTransports.set(transport.sessionId, transport);
    console.log('[SSE] Transport stored. Active transports:', activeTransports.size);
    
    // Clean up on close
    transport.onclose = () => {
      console.log(`[SSE] Transport closed for session ${transport.sessionId}`);
      activeTransports.delete(transport.sessionId);
      console.log('[SSE] Active transports after cleanup:', activeTransports.size);
    };
    
    // Set up error handler
    transport.onerror = (error) => {
      console.error('[SSE] Transport error:', error);
    };
    
    // Connect the MCP server to this transport
    // Note: mcpServer.connect() automatically calls transport.start()
    console.log('[SSE] Connecting MCP server to transport (this will start the SSE connection)...');
    await mcpServer.connect(transport);
    
    console.log(`[SSE] ✓ MCP server connected and SSE started successfully (session: ${transport.sessionId})`);
  } catch (error) {
    console.error('[SSE] ✗ Error setting up SSE connection:');
    console.error('[SSE] Error name:', error.name);
    console.error('[SSE] Error message:', error.message);
    console.error('[SSE] Error stack:', error.stack);
    
    if (!res.headersSent) {
      console.log('[SSE] Sending 500 error response');
      res.status(500).json({
        error: error.message,
        name: error.name,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    } else {
      console.log('[SSE] Headers already sent, cannot send error response');
    }
  }
});

// Message endpoint (POST) - Receives messages from the client
app.post('/message', async (req, res) => {
  console.log('[MESSAGE] Incoming POST to /message');
  console.log('[MESSAGE] Body:', JSON.stringify(req.body).substring(0, 200));
  
  // Validate API key
  const apiKey = req.header('x-api-key');
  console.log('[MESSAGE] API key received:', apiKey ? 'Yes' : 'No');
  
  if (!apiKey || apiKey.trim() !== MCP_API_KEY) {
    console.log('[MESSAGE] Authentication failed');
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  console.log('[MESSAGE] Authentication successful');
  
  try {
    // The client should include a session ID in the message or we need to route it
    // For now, we'll use the first (and likely only) active transport
    console.log('[MESSAGE] Active transports count:', activeTransports.size);
    const transport = activeTransports.values().next().value;
    
    if (!transport) {
      console.log('[MESSAGE] ✗ No active SSE connection found');
      return res.status(400).json({ error: 'No active SSE connection' });
    }
    
    console.log('[MESSAGE] Using transport with session:', transport.sessionId);
    console.log('[MESSAGE] Calling transport.handlePostMessage...');
    
    // Let the transport handle the message
    await transport.handlePostMessage(req, res, req.body);
    
    console.log('[MESSAGE] ✓ Message handled successfully');
  } catch (error) {
    console.error('[MESSAGE] ✗ Error handling message:');
    console.error('[MESSAGE] Error name:', error.name);
    console.error('[MESSAGE] Error message:', error.message);
    console.error('[MESSAGE] Error stack:', error.stack);
    
    if (!res.headersSent) {
      console.log('[MESSAGE] Sending 500 error response');
      res.status(500).json({
        error: error.message,
        name: error.name,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    } else {
      console.log('[MESSAGE] Headers already sent, cannot send error response');
    }
  }
});

// Start the server
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('Langflow MCP Server (SSE) Started');
  console.log('='.repeat(60));
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  Info:    http://localhost:${PORT}/`);
  console.log(`  SSE:     http://localhost:${PORT}/sse (GET)`);
  console.log(`  Message: http://localhost:${PORT}/message (POST)`);
  console.log('');
  console.log('Environment Variables:');
  console.log(`  MCP_API_KEY: ${MCP_API_KEY ? '✓ Set' : '✗ Missing'}`);
  console.log(`  DATASTAX_LANGFLOW_URL: ${DATASTAX_LANGFLOW_URL ? '✓ Set' : '✗ Missing'}`);
  console.log(`  LANGFLOW_TENANT_ID: ${LANGFLOW_TENANT_ID ? '✓ Set' : '✗ Missing'}`);
  console.log(`  FLOW_ID: ${FLOW_ID ? '✓ Set' : '✗ Missing'}`);
  console.log(`  ASTRA_ORG_ID: ${ASTRA_ORG_ID ? '✓ Set' : '✗ Missing'}`);
  console.log(`  APPLICATION_TOKEN: ${APPLICATION_TOKEN ? '✓ Set' : '✗ Missing'}`);
  console.log('='.repeat(60));
});

// Made with Bob
