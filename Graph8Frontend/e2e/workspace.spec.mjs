import { test, expect } from '@playwright/test';
const suffix=Date.now();
test('buyer room, experiment, goal automation and responsive journeys',async({page,context})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:'Make your next move count.'})).toBeVisible();
 
 await page.screenshot({path:'test-results/overview-desktop.png',fullPage:true});await page.getByRole('navigation').getByRole('button',{name:'Buyer Deal Rooms'}).click();
 await page.getByRole('button',{name:'＋ Create room',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByLabel('Name',{exact:true}).fill(`Acme evaluation ${suffix}`);await dialog.getByLabel('Company',{exact:true}).fill('Acme');await dialog.getByLabel('Welcome message').fill('Our shared evaluation and launch plan.');await dialog.getByRole('button',{name:'Create room →',exact:true}).click();
 await expect(page.getByRole('heading',{name:`Acme evaluation ${suffix}`,exact:true})).toBeVisible();
 await page.getByLabel('Next step',{exact:true}).fill('Approve evaluation criteria');await page.getByLabel('Owner',{exact:true}).fill('Buyer team');await page.getByLabel('Allow the buyer').check();await page.getByRole('button',{name:'＋ Add milestone'}).click();
 await expect(page.getByText('Approve evaluation criteria',{exact:true})).toBeVisible();
 await page.getByLabel('Document title').fill('Solution overview');await page.getByLabel('HTTPS link').fill('https://example.com/overview');await page.getByRole('button',{name:'＋ Add resource'}).click();
 await page.getByRole('button',{name:'Create buyer link ↗'}).click();await expect(page.locator('.share-strip a')).toBeVisible();
 const url=await page.locator('.share-strip a').getAttribute('href');const buyer=await context.newPage();await buyer.goto(url);
 await expect(buyer.getByRole('heading',{name:`Acme evaluation ${suffix}`})).toBeVisible();
 await buyer.getByLabel('Your name',{exact:true}).fill('Jordan');await buyer.getByRole('button',{name:'Mark complete'}).click();await expect(buyer.getByRole('button',{name:'Reopen'})).toBeVisible();
 await buyer.getByLabel('Your question',{exact:true}).fill('Can we include a technical review?');await buyer.getByRole('button',{name:'Ask a question →'}).click();await expect(buyer.getByRole('heading',{name:'Can we include a technical review?'})).toBeVisible();
 await page.getByRole('button',{name:'Refresh workspace',exact:true}).click();await page.getByLabel('Response',{exact:true}).fill('Yes, the technical review is included.');await page.getByRole('button',{name:'Save answer'}).click();await buyer.reload();await expect(buyer.getByText('Yes, the technical review is included.',{exact:true})).toBeVisible();
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/buyer-room-desktop.png',fullPage:true});await buyer.setViewportSize({width:390,height:844});await buyer.screenshot({path:'test-results/buyer-mobile.png',fullPage:true});expect(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Revoke',exact:true}).click();await buyer.reload();await expect(buyer.getByRole('alert')).toContainText('expired or been revoked');await buyer.close();
 await page.getByRole('navigation').getByRole('button',{name:'Campaign Learning Lab'}).click();await page.getByRole('button',{name:'＋ New experiment'}).click();
 await dialog.getByLabel('Name',{exact:true}).fill(`Value proposition ${suffix}`);await dialog.getByLabel('Hypothesis').fill('Outcome-first copy increases qualified replies.');await dialog.getByLabel('Variant A · Control').fill('Problem first');await dialog.getByLabel('Variant B · Challenger').fill('Outcome first');await dialog.getByRole('button',{name:'Create experiment →'}).click();
 await page.getByLabel('Contact identifiers').fill('buyer-1\nbuyer-2\nbuyer-3\nbuyer-4');await page.getByRole('button',{name:'Assign to A/B'}).click();await expect(page.locator('tbody tr')).toHaveCount(4);await page.getByRole('button',{name:'Start tracking →'}).click();
 await page.getByRole('button',{name:'Import outcomes',exact:true}).click();await dialog.getByLabel('CSV data').fill('contactId,converted\nbuyer-1,true\nbuyer-2,false\nbuyer-3,true\nbuyer-4,false');await dialog.getByRole('button',{name:'Import outcomes',exact:true}).click();await expect(dialog).not.toBeVisible();
 await page.getByRole('button',{name:'Complete experiment',exact:true}).click();await expect(page.getByText('Inconclusive. Keep the hypothesis open.',{exact:true})).toBeVisible();await page.getByLabel('Learning note').fill('Small sample: continue collecting evidence before changing our messaging.');await page.getByRole('button',{name:'Save learning'}).click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/learning-lab-desktop.png',fullPage:true});
 await page.getByRole('navigation').getByRole('button',{name:'Run My Goal'}).click();await page.getByRole('button',{name:'＋ Set a goal',exact:true}).click();await dialog.getByLabel('What do you want to achieve?').fill(`Enterprise pipeline ${suffix}`);await dialog.getByLabel('Who is your audience?').fill('Operations leaders at SaaS companies');await dialog.getByRole('button',{name:'Build my plan →'}).click();
 await expect(page.getByRole('heading',{name:'Your execution plan'})).toBeVisible();
 await page.getByRole('button',{name:'Enable local autopilot'}).click();
 const activate=page.getByRole('button',{name:/Approve plan|Activate|Start goal/});await activate.click();
 await expect(page.locator('.receipt')).toHaveCount(2,{timeout:20000});await expect(page.locator('.plan-step').last()).toContainText('pending');
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/goal-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'test-results/goal-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.reload();await expect(page.getByRole('heading',{name:'Run My Goal',exact:true})).toBeVisible();await page.getByRole('button').filter({has:page.getByRole('heading',{name:`Enterprise pipeline ${suffix}`,exact:true})}).click();await expect(page.locator('.receipt')).toHaveCount(2);
 expect(errors).toEqual([]);
});

