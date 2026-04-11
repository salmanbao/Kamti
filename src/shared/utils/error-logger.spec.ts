// logError.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import logError from './error-logger'; // Adjust path if needed

describe('Error Logger (Integration Test)', () => {
  let testingModule: TestingModule;

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      providers: [],
    }).compile();
  });

  it('should insert an error log into MongoDB', async () => {
    const resultId = await logError({
      app: 'jest-test-service',
      error_message: 'Jest test error',
      error_body: { detail: 'Testing the raw DB logger' },
      error_code: 'JEST_001',
      stack_trace: 'logError.spec.ts:21',
      location: 'app/shared/utils/error-logger.spec.ts',
    });

    // Check inserted ID exists
    expect(resultId).toBeDefined();
    expect(typeof resultId).toBe('object');
  });

  afterAll(async () => {
    await testingModule.close();
  });
});
