import 'dotenv/config';

// Demonstrates programmatic portal start — the same flow the UI uses.
// For the interactive demo, open http://localhost:5173/cases and click "New Case".

const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';
const FLOWSTILE_API_KEY = process.env.FLOWSTILE_API_KEY ?? 'fsk_dev_local_worker_DO_NOT_USE_IN_PROD';

async function main() {
  // Find the Loan Processing process
  const processesRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes?limit=50`, {
    headers: { Authorization: `Bearer ${FLOWSTILE_API_KEY}` },
  });
  if (!processesRes.ok) throw new Error(`Failed to fetch processes: ${processesRes.status}`);
  const processes = await processesRes.json() as { items: { id: string; name: string }[] };
  const loanProcess = processes.items.find((p) => p.name === 'Loan Processing');
  if (!loanProcess) throw new Error('Loan Processing process not found — run db:seed first');

  // Start via portal start endpoint
  const startRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes/${loanProcess.id}/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FLOWSTILE_API_KEY}`,
    },
    body: JSON.stringify({
      data: {
        CUSTOMER_NAME: 'John Doe',
        AMOUNT: 50000,
      },
    }),
  });

  if (!startRes.ok) {
    const body = await startRes.text();
    throw new Error(`Portal start failed (${startRes.status}): ${body}`);
  }

  const { processInstanceId, caseId } = await startRes.json() as { processInstanceId: string; caseId: string };

  console.log(`\nLoan application started!`);
  console.log(`  Process Instance: ${processInstanceId}`);
  console.log(`  Case ID:          ${caseId}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open http://localhost:5173/cases/${caseId}`);
  console.log(`  2. Login as bob@example.com / password (loan officer)`);
  console.log(`  3. Find the review task in the inbox and complete it`);
}

main().catch((err) => {
  console.error('Failed to start loan workflow:', err);
  process.exit(1);
});
