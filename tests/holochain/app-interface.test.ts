import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppInterfaceAdmin,
  PIPELINE_ORIGIN,
  appInterfacePort,
} from "../../src/holochain/app-interface.js";

/** An admin connection holding `interfaces`; attaching adds one on port 9000. */
function fakeAdmin(
  interfaces: {
    port: number;
    allowed_origins: string;
    installed_app_id?: string | null;
  }[],
) {
  const admin: AppInterfaceAdmin & { attached: number } = {
    attached: 0,
    listAppInterfaces: async () => interfaces,
    attachAppInterface: async () => {
      admin.attached++;
      interfaces.push({ port: 9000, allowed_origins: PIPELINE_ORIGIN });
      return { port: 9000 };
    },
  };
  return admin;
}

test("a given port is used and nothing is attached", async () => {
  const admin = fakeAdmin([]);
  assert.equal(await appInterfacePort(admin, "unyt", 30001), 30001);
  assert.equal(admin.attached, 0);
});

test("an interface the pipeline attached before is reused", async () => {
  const admin = fakeAdmin([
    { port: 4000, allowed_origins: "*" },
    { port: 5000, allowed_origins: PIPELINE_ORIGIN, installed_app_id: null },
  ]);
  assert.equal(await appInterfacePort(admin, "unyt", undefined), 5000);
  assert.equal(admin.attached, 0);
});

test("an interface bound to another app is not reused", async () => {
  const admin = fakeAdmin([
    { port: 5000, allowed_origins: PIPELINE_ORIGIN, installed_app_id: "other" },
  ]);
  assert.equal(await appInterfacePort(admin, "unyt", undefined), 9000);
  assert.equal(admin.attached, 1);
});

test("repeated runs attach one interface in all", async () => {
  const admin = fakeAdmin([{ port: 4000, allowed_origins: "*" }]);
  for (let run = 0; run < 3; run++) {
    assert.equal(await appInterfacePort(admin, "unyt", undefined), 9000);
  }
  assert.equal(admin.attached, 1);
});
