// jobQueue.js
import { Queue } from 'bullmq';
import redis from './redisClient.js';

const connection = { connection: redis };


export const tradeQueue = new Queue('trades', connection);
export const llmQueue   = new Queue('llm',    connection);
export const apiQueue   = new Queue('apiTasks', connection);

// Funciones helper para encolar trabajos:
export function enqueueTrade(payload) {
  return tradeQueue.add('execute-trade', payload);
}

export function enqueueLLM(payload) {
  return llmQueue.add('llm-task', payload);
}

export function enqueueAPITask(payload) {
  return apiQueue.add('api-task', payload);
}
