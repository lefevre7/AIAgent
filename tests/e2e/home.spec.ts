import { expect, test } from "@playwright/test";

test("renders the bootstrap control plane", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "AIAgent" })).toBeVisible();
  await expect(page.getByText("One local dashboard for gateway health, sessions, approvals, steering, memory, logs, tunnel exposure, and channel routing.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Create Session" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Memory Inspection" })).toBeVisible();
});

test("creates and completes a session from the web control plane", async ({ page }) => {
  await page.goto("/");

  const createSessionForm = page.locator('form[action="/api/control-plane/sessions"]');
  await createSessionForm.getByLabel("Title").fill("Web E2E Session");
  await createSessionForm.getByLabel("Goal").fill("Complete the fake web task.");
  await createSessionForm.getByLabel("Initial message").fill("Finish the web control-plane task.");
  await createSessionForm.getByRole("button", { name: "Create Session" }).click();

  await expect(page.getByText("Session created.")).toBeVisible();

  await expect
    .poll(async () => {
      await page.reload();
      return page.locator("main").textContent();
    })
    .toContain("Completed fake task");
});
