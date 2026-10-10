import { assertEquals } from '@std/assert';
import { loadConfig } from '../supabase/functions/_shared/config.ts';

const CONTRACT_ID = `C${'A'.repeat(55)}`;
const USDC_CONTRACT_ID = `C${'B'.repeat(55)}`;

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    INDEXER_TASK_SECRET: 'a'.repeat(48),
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    FACTORY_CONTRACT_ID: CONTRACT_ID,
    USDC_CONTRACT_ID,
    STELLAR_NETWORK: 'testnet',
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

Deno.test('accepts a valid configuration with sensible defaults', () => {
  const result = loadConfig(validEnv());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.config.maxLedgersPerRun, 1000);
    assertEquals(result.config.startLedger, 1);
    assertEquals(result.config.allowMainnet, false);
    assertEquals(result.config.network, 'testnet');
  }
});

Deno.test('reports every missing required variable', () => {
  const result = loadConfig({ SUPABASE_URL: 'https://example.supabase.co' });
  assertEquals(result.ok, false);
  if (!result.ok) {
    for (const key of ['INDEXER_TASK_SECRET', 'FACTORY_CONTRACT_ID', 'USDC_CONTRACT_ID']) {
      assertEquals(result.missing.includes(key), true, key);
    }
    assertEquals(result.missing.includes('STELLAR_RPC_URL'), true);
  }
});

Deno.test('treats blank values as missing rather than valid', () => {
  const result = loadConfig(validEnv({ SUPABASE_URL: '   ' }));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.missing.includes('SUPABASE_URL'), true);
});

Deno.test('rejects a short task secret', () => {
  const result = loadConfig(validEnv({ INDEXER_TASK_SECRET: 'short' }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.invalid.some((item) => item.startsWith('INDEXER_TASK_SECRET')), true);
  }
});

Deno.test('rejects malformed contract ids', () => {
  for (const key of ['FACTORY_CONTRACT_ID', 'USDC_CONTRACT_ID']) {
    const result = loadConfig(validEnv({ [key]: 'not-a-contract' }));
    assertEquals(result.ok, false, key);
    if (!result.ok) {
      assertEquals(result.invalid.some((item) => item.startsWith(key)), true, key);
    }
  }
});

Deno.test('rejects a non-https Supabase URL', () => {
  assertEquals(loadConfig(validEnv({ SUPABASE_URL: 'http://example.supabase.co' })).ok, false);
});

Deno.test('rejects a non-https RPC URL', () => {
  assertEquals(loadConfig(validEnv({ STELLAR_RPC_URL: 'http://rpc.example.com' })).ok, false);
});

Deno.test('refuses mainnet without explicit opt-in', () => {
  const result = loadConfig(
    validEnv({
      STELLAR_NETWORK: 'mainnet',
      STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.invalid.some((item) => item.includes('ALLOW_MAINNET')), true);
  }
});

Deno.test('allows mainnet with explicit opt-in', () => {
  const result = loadConfig(
    validEnv({
      STELLAR_NETWORK: 'mainnet',
      ALLOW_MAINNET: 'true',
      STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    }),
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.config.allowMainnet, true);
});

Deno.test('rejects a passphrase that does not match the network', () => {
  const mismatches: Array<Record<string, string>> = [
    // Testnet passphrase (validEnv default) under mainnet.
    { STELLAR_NETWORK: 'mainnet', ALLOW_MAINNET: 'true' },
    // Mainnet passphrase under testnet.
    {
      STELLAR_NETWORK: 'testnet',
      STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    },
    // Standalone passphrase under testnet.
    {
      STELLAR_NETWORK: 'testnet',
      STELLAR_NETWORK_PASSPHRASE: 'Standalone Network ; February 2017',
    },
    // Literal-quote artefact of the old deploy script.
    {
      STELLAR_NETWORK: 'testnet',
      STELLAR_NETWORK_PASSPHRASE: '"Test SDF Network ; September 2015"',
    },
  ];
  for (const overrides of mismatches) {
    const result = loadConfig(validEnv(overrides));
    assertEquals(result.ok, false, JSON.stringify(overrides));
    if (!result.ok) {
      assertEquals(
        result.invalid.some((item) => item.startsWith('STELLAR_NETWORK_PASSPHRASE')),
        true,
        JSON.stringify(overrides),
      );
    }
  }
});

Deno.test('accepts any non-empty passphrase for a local network', () => {
  const result = loadConfig(
    validEnv({
      STELLAR_NETWORK: 'local',
      STELLAR_NETWORK_PASSPHRASE: 'My Local Network ; Operator Choice 2026',
    }),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.config.network, 'local');
    assertEquals(result.config.networkPassphrase, 'My Local Network ; Operator Choice 2026');
  }
});

Deno.test('rejects an unknown network', () => {
  assertEquals(loadConfig(validEnv({ STELLAR_NETWORK: 'futurenet' })).ok, false);
});

Deno.test('accepts valid ledger budget and start ledger overrides', () => {
  const result = loadConfig(
    validEnv({ INDEXER_MAX_LEDGER_RANGE: '250', INDEXER_START_LEDGER: '1234' }),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.config.maxLedgersPerRun, 250);
    assertEquals(result.config.startLedger, 1234);
  }
});

Deno.test('rejects an out-of-range ledger budget', () => {
  for (const value of ['0', '-5', '999999', 'abc', '1.5']) {
    assertEquals(loadConfig(validEnv({ INDEXER_MAX_LEDGER_RANGE: value })).ok, false, value);
  }
});

Deno.test('rejects an invalid start ledger', () => {
  for (const value of ['0', '-1', 'abc']) {
    assertEquals(loadConfig(validEnv({ INDEXER_START_LEDGER: value })).ok, false, value);
  }
});

Deno.test('does not echo secret values in the result', () => {
  const secret = 'super-secret-task-value'.repeat(2);
  const result = loadConfig(validEnv({ STELLAR_NETWORK: 'bogus', INDEXER_TASK_SECRET: secret }));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(JSON.stringify(result.invalid).includes(secret), false);
    assertEquals(JSON.stringify(result.missing).includes(secret), false);
  }
});
