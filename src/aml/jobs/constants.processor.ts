export const AmlProcessorQueueName = 'aml';
export enum AmlCallbackProcessorJobName {
  AmlCallback = 'aml-callback',
}

export const AmlCallbackProcessorQueueName = 'aml-callback';
export enum AmlProcessorJobName {
  CheckAml = 'check-aml',
}

const retryOnFailAfter = 1 * 60 * 1000; // 1 minute
export const AmlCallbackQueueOptions = {
  backoff: { type: 'exponential', delay: retryOnFailAfter },
  delay: 0,
  attempts: 3,
  removeOnComplete: true,
};
