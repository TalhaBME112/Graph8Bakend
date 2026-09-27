import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { vi } from 'vitest';

describe('Growth workspace', () => {
  beforeEach(() => {
    location.hash = ''; sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ok:true,json:async()=>url.includes('status')?{configured:false,mode:'Local workspace',sdkVersion:'0.245.0'}:{rooms:[],experiments:[],goals:[]}})));
    TestBed.configureTestingModule({imports:[App]});
  });
  afterEach(() => vi.unstubAllGlobals());
  it('renders all three modules and honest local connection status', async () => {
    const fixture=TestBed.createComponent(App); await fixture.whenStable(); fixture.detectChanges();
    const text=fixture.nativeElement.textContent;
    expect(text).toContain('Buyer Deal Room'); expect(text).toContain('Campaign Learning Lab'); expect(text).toContain('Run My Goal'); expect(text).toContain('Local workspace');
  });
  it('switches modules and opens the appropriate creation form', async () => {
    const fixture=TestBed.createComponent(App); await fixture.whenStable();
    fixture.componentInstance.go('lab'); fixture.componentInstance.open('experiment'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]').textContent).toContain('Design an experiment');
    expect(fixture.nativeElement.querySelector('input[name="minimum"]').value).toBe('30');
  });
  it('shows server errors instead of indicating success', async () => {
    const fixture=TestBed.createComponent(App); await fixture.whenStable();
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:503,json:async()=>({error:'Connect Graph8 first.'})})));
    await fixture.componentInstance.loadGraph('deals'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Connect Graph8 first.');
    expect(fixture.componentInstance.connectionVerified()).toBe(false);
  });
});
