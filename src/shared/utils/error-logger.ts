// errorLogger.js
import { Db, MongoClient } from 'mongodb';
import { stringLogLimit } from './index.utils';
import { AmlError } from '@aml/enums/aml-error';

// SECURITY: Use environment variables for MongoDB credentials
// Never commit credentials directly in code
const uri =
  process.env.ERROR_LOGGER_MONGODB_URI ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/abot-microservices';
const dbName = process.env.ERROR_LOGGER_DB_NAME || 'error_logging_db';
const collectionName = process.env.ERROR_LOGGER_COLLECTION_NAME || 'error_logs';

// Shared MongoClient instance for connection reuse
let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

async function getDb() {
  if (
    cachedDb &&
    cachedClient &&
    (cachedClient as any).topology &&
    (cachedClient as any).topology.isConnected()
  ) {
    return cachedDb;
  }

  // Validate MongoDB URI is configured
  if (!uri || uri === 'mongodb://localhost:27017/abot-microservices') {
    console.warn(
      'Error logger: MongoDB URI not configured, using default local connection',
    );
  }

  try {
    cachedClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000, // Timeout for server selection
      socketTimeoutMS: 10000, // Socket timeout
      maxPoolSize: 10, // Connection pool size
    });
    await cachedClient.connect();
    cachedDb = cachedClient.db(dbName);
    console.log(`✅ Error logger connected to MongoDB (db: ${dbName})`);
    return cachedDb;
  } catch (err) {
    console.error('❌ Error logger failed to connect to MongoDB:', err.message);
    console.error(
      '   Check ERROR_LOGGER_MONGODB_URI or MONGODB_URI environment variable',
    );
    cachedClient = null;
    cachedDb = null;
    return null; // Return null on failure; caller will handle
  }
}

async function logError({
  app = 'Microservice',
  error_message,
  error_body = null,
  error_code = null,
  stack_trace = null,
  location = null,
}: any) {
  // Optional fields type check
  if (
    error_code !== null &&
    typeof error_code !== 'string' &&
    typeof error_code !== 'number'
  ) {
    console.warn(
      'logError(): "error_code" should be string or number, received:',
      typeof error_code,
    );
  }
  if (stack_trace !== null && typeof stack_trace !== 'string') {
    console.warn('logError(): "stack_trace" should be string');
  }
  if (location !== null && typeof location !== 'string') {
    console.warn('logError(): "location" should be string');
  }

  const STRING_LIMIT = 500;

  const payload = {
    app,
    error_message: stringLogLimit(error_message, STRING_LIMIT),
    error_body,
    error_code,
    stack_trace,
    location,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const db = await getDb();
  if (!db) {
    console.error('Error logger: DB unavailable. Dropping log:', payload);
    return { ...payload, logged: false, reason: 'DB_UNAVAILABLE' };
  }

  try {
    const collection = db.collection(collectionName);
    const result = await collection.insertOne(payload);

    return { ...payload, _id: result.insertedId, logged: true };
  } catch (err) {
    console.error('Failed to insert error log:', err.message);
    return { ...payload, logged: false, reason: err.message };
  }
}

export function mapCatchError(
  error: Error,
  errorCode: string = AmlError.AML_CHECK_FAILED,
) {
  let location: string | null = null;
  if (error.stack) {
    const stackLines = error.stack.split('\n');
    if (stackLines.length > 1) {
      const match = stackLines[1].match(/\((.*):\d+:\d+\)/);
      if (match && match[1]) {
        location = match[1];
      }
    }
  }

  return {
    error_message: error.message,
    stack_trace: error.stack || null,
    error_code: errorCode,
    location,
  };
}

// Graceful shutdown: Close connection on process exit
process.on('SIGINT', async () => {
  if (cachedClient) {
    await cachedClient.close();
    console.log('MongoDB connection closed');
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (cachedClient) {
    await cachedClient.close();
    console.log('MongoDB connection closed');
  }
  process.exit(0);
});

export default logError;
