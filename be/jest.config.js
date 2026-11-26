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
  // Postgres 컨테이너는 실행 전체에서 하나다(이슈 152). test/db.ts의 startTestDb()가 쓴다.
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
};
