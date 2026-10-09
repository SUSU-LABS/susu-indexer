#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------------
# Deploy script for SUSU Indexer
# -------------------------------------------------------------------------

# ... (previous parts of the script unchanged)

# -------------------------------------------------------------------------
# Write environment variables to the .env file
# -------------------------------------------------------------------------
# NOTE: The following block writes each required variable to the .env file.
# The original implementation wrapped STELLAR_NETWORK_PASSPHRASE in literal
# quotes, which caused the stored value to include the quote characters.
# This has been fixed to write the value unquoted.

cat >> .env <<EOF
# Stellar configuration
STELLAR_NETWORK=${STELLAR_NETWORK}
STELLAR_NETWORK_PASSPHRASE=${STELLAR_NETWORK_PASSPHRASE}
# ... other variables
EOF

# ... (remaining parts of the script unchanged)
