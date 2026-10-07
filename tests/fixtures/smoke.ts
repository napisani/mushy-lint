// The test transport is local so this fixture never needs a provider credential.
export function load() {
  try {
    return read();
  } catch (error) {
    throw error;
  }
}
