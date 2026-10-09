import { z } from "zod";

/**
 * Known Stellar network passphrases.
 * These are the official passphrases used by the Stellar public and test networks.
 */
const KNOWN_NETWORK_PASSPHRASES: Record<string, string> = {
  PUBLIC: "Public Global Stellar Network ; September 2015",
  TESTNET: "Test SDF Network ; September 2015",
};

/**
 * Schema for environment configuration.
 * `STELLAR_NETWORK_PASSPHRASE` is kept as a required variable but its value
 * must be consistent with `STELLAR_NETWORK`.
 */
export const configSchema = z.object({
  STELLAR_NETWORK: z
    .enum(["PUBLIC", "TESTNET"])
    .default("TESTNET")
    .describe("Stellar network identifier (PUBLIC or TESTNET)"),
  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .describe(
      "Passphrase for the selected Stellar network. Must match the official network passphrase."
    ),
  // ... other configuration variables
});

/**
 * Type inferred from the Zod schema.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Loads and validates the configuration from environment variables.
 *
 * In addition to the Zod validation, this function checks that the provided
 * `STELLAR_NETWORK_PASSPHRASE` matches the known passphrase for the selected
 * `STELLAR_NETWORK`. If the values are inconsistent, an error is thrown.
 *
 * @returns {Config} The validated configuration object.
 * @throws {Error} If the network/passphrase pair is invalid.
 */
export const loadConfig = (): Config => {
  const env = process.env;

  // Parse the basic schema first.
  const parsed = configSchema.parse({
    STELLAR_NETWORK: env.STELLAR_NETWORK,
    STELLAR_NETWORK_PASSPHRASE: env.STELLAR_NETWORK_PASSPHRASE,
    // ... map other env vars here
  });

  // -------------------------------------------------------------------------
  // Consistency check between network and passphrase
  // -------------------------------------------------------------------------
  const expectedPassphrase = KNOWN_NETWORK_PASSPHRASES[parsed.STELLAR_NETWORK];
  if (expectedPassphrase && parsed.STELLAR_NETWORK_PASSPHRASE !== expectedPassphrase) {
    throw new Error(
      `STELLAR_NETWORK_PASSPHRASE does not match the expected passphrase for network "${parsed.STELLAR_NETWORK}". ` +
        `Expected "${expectedPassphrase}", got "${parsed.STELLAR_NETWORK_PASSPHRASE}".`
    );
  }

  // If the network is not one of the known ones (e.g., a custom network),
  // we simply trust the provided passphrase – no validation is performed.

  return parsed;
};
