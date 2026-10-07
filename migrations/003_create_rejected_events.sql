-- Persist rejected (unrecognized) chain events for durability and alerting.
CREATE TABLE rejected_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_address TEXT NOT NULL,
    topics TEXT NOT NULL,
    data TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    decoder_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
