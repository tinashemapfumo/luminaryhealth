/**
 * Contract test: the two permission matrices must agree.
 *
 * `src/platform/permissions.ts` and the frontend's `src/config/permissions.js`
 * are duplicated on purpose — one decides what is *allowed*, the other what is
 * *drawn* — and the README has said since the first version that a contract
 * test should assert they agree. This is that test.
 *
 * What it does NOT do is merge them. The duplication is the design; drift is
 * the defect. Sharing one module would let a single check appear to cover both
 * questions, and hiding a button is not access control.
 *
 * Reads the frontend file directly rather than through a build. That is why the
 * matrix was extracted out of `config/access.js`, which imports icon
 * components: this script has no bundler and no React, and should not need one
 * to answer a question about a lookup table.
 *
 *     npm run contract:permissions
 *
 * Exits non-zero on any disagreement, so CI fails rather than warns.
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolePermissions, type Permission, type Role } from '../src/platform/permissions.js';

const here = dirname(fileURLToPath(import.meta.url));

// The frontend is a sibling checkout, not a dependency. An override exists
// because the two are not required to sit side by side on every machine.
const frontendMatrix = resolve(
  process.env.FRONTEND_PERMISSIONS ??
    join(here, '..', '..', 'luminary-frontend-project', 'src', 'config', 'permissions.js'),
);

if (!existsSync(frontendMatrix)) {
  console.error(`Cannot find the frontend permission matrix at:\n  ${frontendMatrix}`);
  console.error('Set FRONTEND_PERMISSIONS to its path if the checkout lives elsewhere.');
  process.exit(2);
}

interface FrontendRole {
  can: Record<string, boolean>;
}

const frontend = (await import(pathToFileURL(frontendMatrix).href)) as {
  PERMISSIONS: { key: string; label: string; group: string }[];
  roleAccess: Record<string, FrontendRole>;
};

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

const serverRoles = Object.keys(rolePermissions).sort();
const clientRoles = Object.keys(frontend.roleAccess).sort();

// --- roles ---------------------------------------------------------------
if (serverRoles.join(',') !== clientRoles.join(',')) {
  fail(`Roles differ.\n    server: ${serverRoles.join(', ')}\n    client: ${clientRoles.join(', ')}`);
}

// --- permission keys -----------------------------------------------------
//
// The server's set is taken from a role's own keys rather than from the
// `Permission` union, because a type cannot be enumerated at runtime — and a
// permission declared in the union but never given a value would be exactly the
// kind of omission worth catching.
const serverKeys = Object.keys(rolePermissions.admin).sort();
const clientKeys = frontend.PERMISSIONS.map((p) => p.key).sort();

const missingFromClient = serverKeys.filter((k) => !clientKeys.includes(k));
const missingFromServer = clientKeys.filter((k) => !serverKeys.includes(k));

if (missingFromClient.length > 0) {
  fail(`The server enforces permissions the client never draws: ${missingFromClient.join(', ')}`);
}
if (missingFromServer.length > 0) {
  fail(`The client draws permissions the server does not enforce: ${missingFromServer.join(', ')}`);
}

// A role that omits a key denies it, which is safe — but it also means the two
// files disagree about what exists, so it is still reported.
for (const role of clientRoles) {
  const declared = Object.keys(frontend.roleAccess[role]!.can).sort();
  const absent = clientKeys.filter((k) => !declared.includes(k));
  if (absent.length > 0) {
    fail(`Client role "${role}" gives no value for: ${absent.join(', ')}`);
  }
}

// --- every cell ----------------------------------------------------------
const shared = serverKeys.filter((k) => clientKeys.includes(k));
let compared = 0;

for (const role of serverRoles.filter((r) => clientRoles.includes(r))) {
  for (const key of shared) {
    const onServer = rolePermissions[role as Role][key as Permission] === true;
    const onClient = frontend.roleAccess[role]!.can[key] === true;
    compared += 1;

    if (onServer !== onClient) {
      // Which way round matters: a client that grants what the server refuses
      // is a broken button, while a client that hides what the server permits
      // is a feature nobody can reach. Neither is acceptable, but they are
      // different bugs and the message should say which one this is.
      fail(
        onClient
          ? `"${role}" is offered ${key} in the interface, but the server refuses it — the button will fail.`
          : `"${role}" is permitted ${key} by the server, but the interface hides it — the capability is unreachable.`,
      );
    }
  }
}

// --- report --------------------------------------------------------------
if (failures.length === 0) {
  console.log(`✓ permission contract holds — ${serverRoles.length} roles × ${shared.length} permissions, ${compared} cells agree`);
  process.exit(0);
}

console.error(`✗ permission contract broken — ${failures.length} disagreement(s):\n`);
failures.forEach((f) => console.error(`  · ${f}`));
console.error(`\n  server: src/platform/permissions.ts`);
console.error(`  client: ${frontendMatrix}`);
process.exit(1);
