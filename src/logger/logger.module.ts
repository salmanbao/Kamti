import { Module } from '@nestjs/common';
import { MyLogger } from './logger.service';
import { LoggerController } from './logger.controller';

@Module({
  controllers: [LoggerController],
  providers: [MyLogger],
  exports: [MyLogger],
})
export class LoggerModule {}
