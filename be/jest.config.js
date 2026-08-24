module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // Every spec lives in test/; src/ is here so jest's haste map still sees the
  // modules the specs import. Without these, jest crawls worker/.venv (1.4 GB)
  // and storage/ (1.6 GB) on every run.
  roots: ['<rootDir>/src', '<rootDir>/test'],
  modulePathIgnorePatterns: ['<rootDir>/worker/', '<rootDir>/storage/', '<rootDir>/dist/'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 180000,
};
