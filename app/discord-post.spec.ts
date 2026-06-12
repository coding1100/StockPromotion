import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://discord.com/login');
  await page.getByRole('textbox', { name: 'Email or Phone Number' }).click();
  await page.getByRole('textbox', { name: 'Email or Phone Number' }).fill('farazriazdeveloper@gmail.com');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('riaz#321');
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.getByRole('treeitem', { name: 'Dyno , 1 unread message' }).click();
  await page.getByRole('treeitem', { name: 'Unread messages, Eclipse |' }).click();
  await page.getByRole('link', { name: 'unread, 〃🗡﹒trading (text' }).click();
  await page.getByRole('treeitem', { name: 'mention, The Trading Pit' }).click();
  await page.getByRole('treeitem', { name: 'Unread messages, Maven Prop' }).click();
  await page.locator('.inner__74017').click();
  await page.locator('.inner__74017').click();
  await page.getByRole('link', { name: '📢│going-live (text channel)' }).click();
  await page.getByRole('link', { name: 'unread, 💬│maven-hub (text' }).click();
  await page.locator('.markup__75297.editor__1b31f > div').click();
  await page.getByRole('treeitem', { name: 'Unread messages, Campus Town' }).click();
  await page.getByRole('link', { name: 'unread, 💬┃free-chat (text' }).click();
  await page.getByRole('treeitem', { name: 'Unread messages, TradingView' }).click();
  await page.getByRole('link', { name: '💰┃stocks (text channel)' }).click();
  await page.getByRole('link', { name: 'unread, ₿₿┃crypto (text' }).click();
});