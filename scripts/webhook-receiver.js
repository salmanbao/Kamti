#!/usr/bin/env node
/*
 SIMPLE WEBHOOK RECEIVER
 
 A standalone webhook receiver that listens for swap execution notifications.
 Run this server and use its URL as the webhookUrl in your swap execution requests.
 
 Usage:
   # Start webhook receiver on default port 3001
   node scripts/webhook-receiver.js
   
   # Start on custom port
   PORT=4000 node scripts/webhook-receiver.js
   
   # Enable signature verification
   WEBHOOK_SECRET=your-secret-key node scripts/webhook-receiver.js

 Then in your swap execution request:
   {
     "sellToken": {...},
     "buyToken": {...},
     "sellAmount": "1000000",
     "webhookUrl": "http://localhost:3001/webhook",
     "webhookSecret": "your-secret-key"  // if using signature verification
   }
*/

const http = require('http');
const crypto = require('crypto');

// Configuration
const PORT = process.env.PORT || 3001;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const REQUIRE_SIGNATURE = process.env.REQUIRE_SIGNATURE === '1';

// Store received webhooks for review
const receivedWebhooks = [];

// Verify HMAC signature
function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  
  return signature === expectedSignature;
}

// Format timestamp
function formatTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

// Handle webhook request
function handleWebhook(req, res) {
  let body = '';
  
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', () => {
    try {
      // Parse webhook payload
      const payload = JSON.parse(body);
      const signature = req.headers['x-webhook-signature'];
      
      // Verify signature if required
      if (REQUIRE_SIGNATURE || (WEBHOOK_SECRET && signature)) {
        const isValid = verifySignature(body, signature, WEBHOOK_SECRET);
        
        if (!isValid) {
          console.log('\n❌ Invalid webhook signature');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
        
        console.log('✅ Signature verified');
      }
      
      // Store webhook
      receivedWebhooks.push({
        receivedAt: new Date(),
        payload,
        signature: signature || null,
      });
      
      // Log webhook details
      console.log('\n' + '='.repeat(80));
      console.log(`📥 WEBHOOK RECEIVED - ${formatTimestamp(Date.now())}`);
      console.log('='.repeat(80));
      console.log(`Event:        ${payload.event}`);
      console.log(`Execution ID: ${payload.executionId}`);
      console.log(`Job ID:       ${payload.jobId}`);
      console.log(`Timestamp:    ${formatTimestamp(payload.timestamp)}`);
      console.log('');
      
      if (payload.event === 'swap.completed') {
        console.log('✅ SWAP COMPLETED');
        console.log('');
        console.log('Details:');
        console.log(`  • Success:     ${payload.data.success}`);
        console.log(`  • TX Hash:     ${payload.data.transactionHash || 'N/A'}`);
        console.log(`  • Output:      ${payload.data.outputAmount || 'N/A'}`);
        console.log(`  • Duration:    ${payload.data.duration}ms`);
        
        if (payload.data.estimatedOutput) {
          console.log(`  • Est. Output: ${payload.data.estimatedOutput}`);
        }
        
        if (payload.data.priceImpact) {
          console.log(`  • Price Impact: ${payload.data.priceImpact}%`);
        }
      } else if (payload.event === 'swap.failed') {
        console.log('❌ SWAP FAILED');
        console.log('');
        console.log('Error Details:');
        console.log(`  • Message: ${payload.data.error?.message || 'Unknown error'}`);
        console.log(`  • Code:    ${payload.data.error?.code || 'N/A'}`);
        console.log(`  • Duration: ${payload.data.duration}ms`);
      }
      
      console.log('');
      console.log('Full Payload:');
      console.log(JSON.stringify(payload, null, 2));
      console.log('='.repeat(80));
      console.log(`Total webhooks received: ${receivedWebhooks.length}`);
      console.log('');
      
      // Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Webhook received',
        receivedAt: new Date().toISOString(),
      }));
      
    } catch (error) {
      console.error('\n❌ Error processing webhook:', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid payload' }));
    }
  });
}

// Handle history request
function handleHistory(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    total: receivedWebhooks.length,
    webhooks: receivedWebhooks.map(w => ({
      receivedAt: w.receivedAt,
      event: w.payload.event,
      executionId: w.payload.executionId,
      success: w.payload.data.success,
      transactionHash: w.payload.data.transactionHash,
    })),
  }, null, 2));
}

// Handle status request
function handleStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running',
    port: PORT,
    webhookUrl: `http://localhost:${PORT}/webhook`,
    signatureVerification: WEBHOOK_SECRET ? 'enabled' : 'disabled',
    requireSignature: REQUIRE_SIGNATURE,
    totalReceived: receivedWebhooks.length,
    uptime: process.uptime(),
  }, null, 2));
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Signature');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Route requests
  if (req.method === 'POST' && req.url === '/webhook') {
    handleWebhook(req, res);
  } else if (req.method === 'GET' && req.url === '/history') {
    handleHistory(req, res);
  } else if (req.method === 'GET' && req.url === '/status') {
    handleStatus(req, res);
  } else if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Webhook Receiver</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            h1 { color: #333; }
            .info { background: #e3f2fd; padding: 15px; border-radius: 4px; margin: 20px 0; }
            .endpoint { background: #f5f5f5; padding: 10px; border-radius: 4px; font-family: monospace; }
            .status { color: #4caf50; font-weight: bold; }
            code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🔔 Webhook Receiver</h1>
            <p class="status">✅ Server is running on port ${PORT}</p>
            
            <div class="info">
              <h3>Webhook Endpoint:</h3>
              <div class="endpoint">POST http://localhost:${PORT}/webhook</div>
            </div>
            
            <h3>Usage:</h3>
            <p>Include this URL in your swap execution request:</p>
            <pre><code>{
  "webhookUrl": "http://localhost:${PORT}/webhook",
  "webhookSecret": "${WEBHOOK_SECRET || 'your-secret-key'}"
}</code></pre>
            
            <h3>Available Endpoints:</h3>
            <ul>
              <li><code>POST /webhook</code> - Receive webhook notifications</li>
              <li><code>GET /status</code> - Check server status</li>
              <li><code>GET /history</code> - View received webhooks</li>
            </ul>
            
            <h3>Statistics:</h3>
            <p>Total webhooks received: <strong>${receivedWebhooks.length}</strong></p>
            <p>Signature verification: <strong>${WEBHOOK_SECRET ? 'Enabled' : 'Disabled'}</strong></p>
            
            <p style="margin-top: 30px; color: #666;">
              View console output for detailed webhook information.
            </p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Start server
server.listen(PORT, () => {
  console.clear();
  console.log('╔' + '='.repeat(78) + '╗');
  console.log('║' + ' '.repeat(25) + 'WEBHOOK RECEIVER' + ' '.repeat(37) + '║');
  console.log('╚' + '='.repeat(78) + '╝');
  console.log('');
  console.log('✅ Server is running and ready to receive webhooks!');
  console.log('');
  console.log('📡 Webhook Endpoint:');
  console.log(`   http://localhost:${PORT}/webhook`);
  console.log('');
  console.log('🔧 Configuration:');
  console.log(`   Port:                 ${PORT}`);
  console.log(`   Signature Verification: ${WEBHOOK_SECRET ? 'Enabled ✓' : 'Disabled ✗'}`);
  console.log(`   Require Signature:    ${REQUIRE_SIGNATURE ? 'Yes' : 'No'}`);
  console.log('');
  console.log('🌐 Web Interface:');
  console.log(`   http://localhost:${PORT}/`);
  console.log('');
  console.log('📊 API Endpoints:');
  console.log(`   POST http://localhost:${PORT}/webhook  - Receive notifications`);
  console.log(`   GET  http://localhost:${PORT}/status   - Server status`);
  console.log(`   GET  http://localhost:${PORT}/history  - View received webhooks`);
  console.log('');
  console.log('💡 Usage in swap execution:');
  console.log('   {');
  console.log(`     "webhookUrl": "http://localhost:${PORT}/webhook",`);
  if (WEBHOOK_SECRET) {
    console.log(`     "webhookSecret": "${WEBHOOK_SECRET}"`);
  }
  console.log('   }');
  console.log('');
  console.log('⌨️  Press Ctrl+C to stop the server');
  console.log('');
  console.log('─'.repeat(80));
  console.log('Waiting for webhooks...');
  console.log('');
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n\n📊 Summary:');
  console.log(`   Total webhooks received: ${receivedWebhooks.length}`);
  console.log('');
  console.log('👋 Shutting down webhook receiver...');
  server.close(() => {
    console.log('✅ Server stopped');
    process.exit(0);
  });
});
