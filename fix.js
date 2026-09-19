const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  await prisma.$queryRawUnsafe("UPDATE Task SET status = 'UNDER_REVIEW' WHERE id = 'cmu8qyj4w0000ujw00t43mu92'");
  await prisma.$queryRawUnsafe("DELETE FROM Settlement WHERE taskId = 'cmu8qyj4w0000ujw00t43mu92'");
  console.log('Reset complete');
  await prisma.$disconnect();
}
main();