// Mock implementation of axios for tests
const axios = jest.createMockFromModule('axios');

// Create mock methods
axios.create = jest.fn(() => axios);
axios.get = jest.fn();
axios.post = jest.fn();
axios.put = jest.fn();
axios.delete = jest.fn();
axios.patch = jest.fn();
axios.request = jest.fn();

// Mock isAxiosError - this is critical for our tests
axios.isAxiosError = jest.fn((error) => {
  // Check if error has the shape of an AxiosError
  const result = !!(error && error.isAxiosError);
  console.log('axios.isAxiosError called with:', error?.message, 'returning:', result);
  return result;
});

// Mock AxiosError class
class AxiosError extends Error {
  constructor(message, code, config, request, response) {
    super(message);
    this.name = 'AxiosError';
    this.code = code;
    this.config = config;
    this.request = request;
    this.response = response;
    
    // This is important for axios.isAxiosError to work
    this.isAxiosError = true;
  }
}

axios.AxiosError = AxiosError;

module.exports = axios;
module.exports.default = axios;
module.exports.AxiosError = AxiosError;