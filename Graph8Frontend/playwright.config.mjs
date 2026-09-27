import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'**/*.spec.mjs',globalSetup:'./e2e/setup.mjs',workers:1,timeout:120000,use:{baseURL:'http://127.0.0.1:4398',channel:'msedge',headless:true,launchOptions:{args:['--disable-gpu']},viewport:{width:1440,height:1000},trace:'retain-on-failure'}});
