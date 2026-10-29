// Last-resort password reset for an adviser who lost both the password and the recovery code.
// Run on the server: npm run reset-password -- adviser@example.com
// Prints a temporary password; the adviser signs in with it and changes it in Settings.
import { adminResetPassword } from '../src/auth.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run reset-password -- <adviser email>');
  process.exit(1);
}
try {
  const temp = await adminResetPassword(email);
  console.log(`Temporary password for ${email}: ${temp}`);
  console.log('Sign in with it, then change it in Settings. All of this adviser\'s sessions were signed out.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
