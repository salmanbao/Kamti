import {
  Controller,
  Get,
  Param,
  Res,
  Optional,
  Render,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { MongoClient } from 'mongodb';

@Controller('logs')
export class LoggerController {
  @Get('file/:date{/:level}') // New v3 syntax: {/:level} makes it optional
  getLogs(
    @Param('date') date: string,
    @Optional() @Param('level') level: string = 'info', // Defaults to 'info' if missing
    @Res() res: Response,
  ) {
    const logDirectory = path.join(__dirname, '..', '..', 'logs', date);
    const logFileName = `${level}-${date}.log`; // e.g., info-2025-11-21.log
    const logFilePath = path.join(logDirectory, logFileName);

    if (fs.existsSync(logFilePath)) {
      res.sendFile(logFilePath);
    } else {
      res
        .status(404)
        .send(`Log file not found: ${logFileName} for date ${date}`);
    }
  }

  @Get('error')
  @Render('logs-error')
  async renderErrorLogs(
    @Query('search') searchTerm?: string,
    @Query('limit') limit?: string,
  ) {
    const client = new MongoClient(
      'mongodb+srv://faheemkhan198742_db_user:EF5QmW4e805okkiI@abotcluster.i9jnmxn.mongodb.net/?retryWrites=true&w=majority&appName=AbotCluster',
    );

    try {
      await client.connect();
      const db = client.db('error_logging_db');
      const collection = db.collection('error_logs');
      const limitNUmber = parseInt(limit ?? '50');

      let query: any = {};
      if (searchTerm) {
        const regex = new RegExp(searchTerm.trim(), 'i');
        query = {
          $or: [
            { app: regex },
            { error_code: regex },
            { error_message: regex },
            { error_body: regex },
            { location: regex },
            { stack_trace: regex },
          ],
        };
      }

      const logs = await collection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limitNUmber)
        .toArray();

      const formattedLogs = logs.map((log, index) => ({
        ...log,
        index: index + 1,
        createdAt: new Date(log.createdAt).toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        error_body: log.error_body
          ? JSON.stringify(log.error_body, null, 2)
          : '—',
        stack_trace: log.stack_trace || null,
        location: log.location || null,
      }));

      return {
        logs: formattedLogs,
        searchTerm: searchTerm || '',
        error: logs.length === 0 && searchTerm ? 'No results found' : null,
        limit: limitNUmber,
      };
    } catch (err) {
      return { logs: [], error: 'Failed to fetch error logs.' };
    } finally {
      await client.close().catch(console.error); // Graceful close
    }
  }
}
