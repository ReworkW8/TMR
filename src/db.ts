import { PrismaClient } from '@prisma/client';
import { log } from './config';

const prisma = new PrismaClient({
  log: [
    { level: 'warn',  emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('warn',  (e) => log.warn('[prisma]', e.message));
prisma.$on('error', (e) => log.error('[prisma]', e.message));

export { prisma };
