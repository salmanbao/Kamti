import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TransactionMonitorGateway } from './transaction-monitor.gateway';
import { ChainListenerService } from './chain-listener.service';
import { SharedModule } from '@shared/shared.module';

/**
 * Monitoring Module
 *
 * Provides real-time transaction monitoring infrastructure for all blockchains.
 *
 * Exports:
 * - TransactionMonitorGateway - WebSocket server for real-time updates
 * - ChainListenerService - Unified interface for chain-specific listeners
 *
 * Features:
 * - Multi-chain WebSocket monitoring (EVM, Solana, Bitcoin)
 * - Transaction confirmation tracking
 * - Actual received amount parsing
 * - Round-trip swap progress events
 * - Bridge status monitoring
 */
@Module({
  imports: [
    HttpModule, // For Bitcoin blockchain.info API
    SharedModule, // For UnifiedConfigurationService
  ],
  providers: [TransactionMonitorGateway, ChainListenerService],
  exports: [TransactionMonitorGateway, ChainListenerService],
})
export class MonitoringModule {}
