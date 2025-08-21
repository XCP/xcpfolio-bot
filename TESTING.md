# Testing Strategy

## Overview
Testing a financial bot that handles real Bitcoin transactions requires multiple layers of safety and verification. Our testing strategy progresses from isolated unit tests to full end-to-end tests on testnet.

## Test Levels

### 1. Unit Tests (`npm run test:unit`)
Tests individual services in isolation with all dependencies mocked.

**Coverage:**
- BitcoinService: Transaction signing, fee calculation, UTXO handling
- CounterpartyService: API calls, order validation, asset checks
- StateManager: State persistence and retrieval
- Helper functions: WIF conversion, fee calculations

**Key Tests:**
- Fee calculation respects ceiling
- RBF sequence numbers are correct
- UTXO selection works properly
- API error handling
- State transitions

### 2. Integration Tests (`npm run test:integration`)
Tests the FulfillmentProcessor with mocked external services but real internal logic.

**Coverage:**
- Complete order processing flow
- Retry logic with progressive backoff
- RBF triggering and execution
- Single-worker lock mechanism
- Mempool capacity management
- Fee ceiling enforcement

**Key Scenarios:**
- Happy path: Order → Validate → Compose → Sign → Broadcast
- Already transferred assets
- Stuck transactions requiring RBF
- High fee market conditions
- Mempool at capacity
- Concurrent processing attempts

### 3. End-to-End Tests (`npm run test:e2e`)
Tests against real APIs in dry-run mode or on testnet.

**Coverage:**
- API connectivity
- Real order detection
- Transaction composition with actual Counterparty
- Signing with real Bitcoin libraries
- State persistence

**Safety:**
- Always use `DRY_RUN=true` for mainnet
- Use testnet for broadcast tests
- Never commit real private keys

## Test Data

### Mock Orders
```javascript
{
  tx_hash: 'order_12345',
  source: 'buyer_address',      // Buyer
  give_asset: 'XCPFOLIO.ASSET', // What they're buying
  status: 'filled',
  give_asset_info: {
    asset_longname: 'XCPFOLIO.ASSET'
  }
}
```

### Mock Scenarios
1. **Normal fulfillment** - Order filled, asset owned, transfer succeeds
2. **Already transferred** - Asset previously sent to buyer
3. **Invalid order** - Not filled, wrong asset, not owned
4. **Network issues** - API timeouts, broadcast failures
5. **High fees** - Market rate exceeds limits
6. **Stuck transaction** - Requires RBF after 3+ blocks
7. **Dropped transaction** - Fell out of mempool

## Running Tests

### Quick Test
```bash
# Run all tests
npm test

# Run specific test file
npm test bitcoin.service.test.ts

# Watch mode for development
npm run test:watch
```

### Coverage Report
```bash
npm run test:coverage
# Open coverage/index.html in browser
```

### Test Specific Scenarios

#### Test Dry Run Mode
```bash
DRY_RUN=true npm test tests/integration
```

#### Test with Custom Fee Limits
```bash
MAX_TOTAL_FEE_SATS=5000 MAX_FEE_RATE_FOR_NEW_TX=50 npm test
```

#### Test on Testnet (Careful!)
```bash
NETWORK=testnet XCPFOLIO_ADDRESS=your_testnet_address npm run test:e2e
```

## Pre-Production Testing Checklist

### Phase 1: Development
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Code coverage > 80%
- [ ] No TypeScript errors

### Phase 2: Testnet
- [ ] Deploy to testnet with real keys
- [ ] Process test XCPFOLIO orders
- [ ] Verify transfers on blockchain
- [ ] Test RBF with stuck transaction
- [ ] Test fee ceiling protection
- [ ] Monitor for 24 hours

### Phase 3: Mainnet Dry Run
- [ ] Run on mainnet with `DRY_RUN=true`
- [ ] Verify order detection works
- [ ] Check fee calculations are reasonable
- [ ] Confirm no broadcasts occur
- [ ] Review logs for any issues

### Phase 4: Limited Mainnet
- [ ] Start with single test order
- [ ] Use low-value asset first
- [ ] Monitor closely for first 10 orders
- [ ] Verify all transfers complete
- [ ] Check fee spending is within limits

## Continuous Testing

### Monitoring in Production
- Health check endpoint (`/status`)
- Discord/Slack alerts for failures
- Log aggregation for error patterns
- Blockchain verification of transfers

### Regular Validation
- Weekly: Check all processed orders on blockchain
- Monthly: Audit fee spending
- Quarterly: Full system test on testnet

## Common Test Failures

### "No UTXOs available"
- Mock UTXOs not set up correctly
- Test address has no balance
- Previous transaction not confirmed

### "Fee rate too high"
- Test is using mainnet fee rates
- Need to mock fee rates lower
- Adjust MAX_FEE_RATE_FOR_NEW_TX

### "Cannot find module"
- Run `npm install` first
- Check jest.config.js paths
- Verify TypeScript compilation

### "Timeout exceeded"
- API calls need longer timeout
- Add `jest.setTimeout(30000)`
- Mock slow external calls

## Writing New Tests

### Test Structure
```typescript
describe('ServiceName', () => {
  let service: ServiceName;
  
  beforeEach(() => {
    // Setup
  });
  
  afterEach(() => {
    // Cleanup
  });
  
  describe('methodName', () => {
    it('should do expected behavior', async () => {
      // Arrange
      const input = mockData;
      
      // Act
      const result = await service.method(input);
      
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

### Best Practices
1. Test one thing per test
2. Use descriptive test names
3. Mock external dependencies
4. Test error cases
5. Clean up after tests
6. Use meaningful assertions

## Safety Rules

### NEVER
- Run tests with production private keys
- Test on mainnet without DRY_RUN
- Broadcast test transactions to mainnet addresses
- Commit test data with real addresses

### ALWAYS
- Use testnet for broadcast tests
- Mock external services in unit tests
- Verify dry run mode before mainnet tests
- Review test logs before production

## Debugging Tests

### Enable Console Output
```bash
DEBUG=* npm test
```

### Run Single Test
```bash
npm test -- --testNamePattern="should process valid order"
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Jest Debug",
  "program": "${workspaceFolder}/node_modules/.bin/jest",
  "args": ["--runInBand"],
  "console": "integratedTerminal"
}
```

## Test Coverage Goals

- **Unit Tests**: 90% coverage
- **Integration Tests**: 80% coverage
- **Critical Paths**: 100% coverage
  - Order validation
  - Transaction signing
  - Fee calculation
  - RBF logic

---

Remember: This bot handles real money. Test thoroughly, deploy carefully, monitor constantly.