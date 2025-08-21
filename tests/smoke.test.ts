/**
 * Smoke test to verify test setup works
 */

describe('Smoke Test', () => {
  it('should run a basic test', () => {
    expect(true).toBe(true);
  });

  it('should handle async tests', async () => {
    const result = await Promise.resolve(42);
    expect(result).toBe(42);
  });

  it('should access environment variables', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.DRY_RUN).toBe('true');
  });

  it('should handle mocks', () => {
    const mockFn = jest.fn(() => 'mocked');
    expect(mockFn()).toBe('mocked');
    expect(mockFn).toHaveBeenCalled();
  });
});