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
        name: "query_langflow_agent",
        description: "Query the Langflow agent about revenue data in the Technology Sales Revenue data product",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The query to send to the Langflow agent",
            },
            session_id: {
              type: "string",
              description: "Optional session ID for conversation context",
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
  if (request.params.name !== "query_langflow_agent") {
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
  // Validate API key
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey.trim() !== MCP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  console.log('SSE connection established');

  try {
    // Create SSE transport with the response object
    const transport = new SSEServerTransport('/message', res);
    
    // Store transport by session ID for routing messages
    activeTransports.set(transport.sessionId, transport);
    
    // Clean up on close
    transport.onclose = () => {
      console.log(`Transport closed for session ${transport.sessionId}`);
      activeTransports.delete(transport.sessionId);
    };
    
    // Connect the MCP server to this transport
    await mcpServer.connect(transport);
    
    console.log(`MCP server connected via SSE (session: ${transport.sessionId})`);
  } catch (error) {
    console.error('Error setting up SSE connection:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Message endpoint (POST) - Receives messages from the client
app.post('/message', async (req, res) => {
  // Validate API key
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey.trim() !== MCP_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  console.log('Received message:', JSON.stringify(req.body).substring(0, 200));
  
  try {
    // The client should include a session ID in the message or we need to route it
    // For now, we'll use the first (and likely only) active transport
    const transport = activeTransports.values().next().value;
    
    if (!transport) {
      return res.status(400).json({ error: 'No active SSE connection' });
    }
    
    // Let the transport handle the message
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('Error handling message:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Langflow MCP Server (SSE) listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Message endpoint: http://localhost:${PORT}/message`);
});

// Made with Bob
