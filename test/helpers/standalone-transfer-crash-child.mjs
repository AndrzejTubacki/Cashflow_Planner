import { withStandaloneTransferPublisherFixture } from './standalone-transfer-publisher-fixture.js';

// Only the owning test forks this helper and provides its freshly allocated
// temporary directory. Synthetic credentials stay in IPC memory, never files,
// stdout, command arguments or a real server/environment connection.
const [dataDir, phase] = process.argv.slice(2);
if (!process.send || !['afterFinancial', 'afterFilesReady', 'afterRename', 'afterCommit'].includes(phase)) throw new Error('Owned crash fixture required');
process.on('message', () => {});
await withStandaloneTransferPublisherFixture(async fixture => {
  const input = fixture.input();
  await fixture.publisher({ [phase]: async () => {
    process.send({ phase, input, tokens: fixture.tokens });
    await new Promise(() => {});
  } }).submit(fixture.tokens.accessToken, input);
}, null, { dataDir });
