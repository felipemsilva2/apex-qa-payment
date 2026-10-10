const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {fixture, functions, managerHandler, paid, ts, sourceRoot, FixedDate} = require('./billing-lifecycle.node.cjs');
const appRequire = createRequire(path.join(sourceRoot,'package.json'));
const React = appRequire('react');
const {JSDOM} = appRequire('jsdom');
const quiet = {log(){},warn(){},error(){}};
function moduleFromSource(relative, dependencies = {}, runtime = {}) {
  const text = fs.readFileSync(path.join(sourceRoot,relative),'utf8');
  const tree = ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true,relative.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const globals = {};
  for (const node of tree.statements.filter(ts.isImportDeclaration)) {
    if (!node.importClause || node.importClause.isTypeOnly) continue;
    const values = dependencies[node.moduleSpecifier.text];
    assert.ok(values,`Missing dependency fixture: ${node.moduleSpecifier.text}`);
    if(node.importClause.name)globals[node.importClause.name.text]=values.default;
    for (const element of node.importClause.namedBindings?.elements || []) {
      globals[element.name.text]=values[element.propertyName?.text || element.name.text];
    }
  }
  const body = tree.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(tree)).join('\n');
  const exports = {};
  const context=vm.createContext({module:{exports},exports,require:appRequire,Date:FixedDate,Intl,console:quiet,setTimeout,clearTimeout,setInterval,clearInterval,...globals,
    window:global.window,document:global.document,navigator:global.navigator,...runtime});
  vm.runInContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.module.exports;
}
function activeApiGuard(f) {
  vm.runInContext(ts.transpileModule(functions('shared/auth.ts',['getBearerToken','requireUser','isActiveComplimentaryTrial','isExpiredAt','requireActiveTenantUser']),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,f.context);
  f.context.HttpError=class HttpError extends Error{constructor(message,status){super(message);this.status=status;}};
  return ()=>f.context.requireActiveTenantUser(new Request('https://synthetic.invalid/protected',{headers:{Authorization:'Bearer synthetic'}}),{},f.db);
}
function webhookEndpoint(f) {
  const text=fs.readFileSync(path.join(sourceRoot,'supabase/functions/asaas-webhook/index.ts'),'utf8');
  const tree=ts.createSourceFile('webhook.ts',text,ts.ScriptTarget.Latest,true);
  const body=tree.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(tree)).join('\n');
  let handler;
  const context=vm.createContext({...f.context, Request,Response,TextEncoder,crypto:require('node:crypto').webcrypto,
    HttpError:class HttpError extends Error{constructor(message,status=400){super(message);this.status=status;}},
    getErrorStatus:error=>error.status||500,getErrorMessage:error=>error.message||'Unknown synthetic error',
    getSupabaseAdmin:()=>f.db,isActiveComplimentaryTrial:()=>false,
    Deno:{env:{get:name=>({ASAAS_WEBHOOK_TOKEN:'synthetic-webhook-token',ASAAS_ENVIRONMENT:'sandbox'})[name]}},
    sendEmail:async()=>{throw new Error('External messages are disabled in this fixture');},
    getPaymentConfirmedTemplate:()=>'',getPixGeneratedTemplate:()=>'',
    handleApexPayWebhook:async()=>false,serve:value=>{handler=value;},console:quiet,
  });
  vm.runInContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  // Payment side effects under test stay real; external communication is isolated.
  context.createCommissionForPayment=async()=>{};
  context.sendConfirmationEmail=async()=>{};
  return async(event,payment=paid,id='evt_'+event,token='synthetic-webhook-token')=>{
    const response=await handler(new Request('https://synthetic.invalid/webhook',{method:'POST',headers:{'Content-Type':'application/json','asaas-access-token':token},body:JSON.stringify({id,event,payment})}));
    return {http:response.status,body:await response.json()};
  };
}
function suspendedFixture() {
  const f=fixture();
  Object.assign(f.tables.subscriptions[0],{asaas_id:'pau_auth_synthetic',pix_automatic_authorization_id:'auth_synthetic',pix_automatic_payment_id:paid.id,status:'pending',current_period_end:'2026-01-01T12:00:00Z'});
  Object.assign(f.tables.tenants[0],{business_name:'Synthetic Studio',plan_tier:'gym',trial_end:null,is_complimentary:false,subscription_test_blocked:false});
  Object.assign(f.tables.billing_plans[0],{active:true,plan_tier:'gym',name:'Synthetic annual contract',contract_duration_months:12});
  f.tables.subscriptions[0].plan={...f.tables.billing_plans[0]};
  return f;
}
function billingEndpoint(f) {
  let paymentStatus='PENDING';
  const providerCalls=[];
  managerHandler(f,async(url,init)=>{
    assert.ok(!init?.method || init.method==='GET','Verification must not create provider charges');
    const pathname=String(url);providerCalls.push(pathname);
    const payment={...paid,status:paymentStatus,billingType:'PIX',dueDate:'2026-02-08',pixAutomaticAuthorizationId:'auth_synthetic'};
    let data;
    if(pathname.includes('/authorizations/'))data={id:'auth_synthetic',customerId:'cus_synthetic',status:'ACTIVE',paymentCreationMode:'MANUAL',frequency:'MONTHLY',value:249.99};
    else if(pathname.includes('/paymentInstructions'))data={data:[{paymentId:paid.id,authorization:{id:'auth_synthetic'}}]};
    else if(pathname.includes('/pixQrCode'))data={payload:'SYNTHETIC-PIX-CODE',encodedImage:'c3ludGhldGlj'};
    else if(pathname.includes('/payments?'))data={data:[payment],hasMore:false};
    else throw new Error('Unexpected provider URL in synthetic fixture: '+pathname);
    return new Response(JSON.stringify(data),{status:200});
  });
  f.invoke=async body=>{
    const response=await f.handler(new Request('https://synthetic.invalid/manager',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify(body)}));
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
    return {data,error:null};
  };
  return {providerCalls,confirm(){paymentStatus='RECEIVED';}};
}
function renderUi(f, initialPath='/dashboard', component='route', realTenantContext=false) {
  const dom=new JSDOM('<!doctype html><html><body><div id="fixture"></div></body></html>',{url:'https://synthetic.invalid'+initialPath});
  global.window=dom.window;global.document=dom.window.document;global.navigator=dom.window.navigator;global.IS_REACT_ACT_ENVIRONMENT=true;
  const {createRoot}=appRequire('react-dom/client');
  const {MemoryRouter,Routes,Route,useLocation,Navigate}=appRequire('react-router-dom');
  const {act}=React;
  const model={tenant:{...f.tables.tenants[0],current_period_end:f.tables.subscriptions[0].current_period_end},navigation:[],apiCalls:[],channels:[]};
  const TenantFixtureContext=React.createContext(model.tenant);
  const paymentIntervals=new Map();let intervalId=0;
  const dependencies={
    react:React,'react-router-dom':{Navigate,useLocation,useNavigate:()=>target=>model.navigation.push(target)},
    'lucide-react':appRequire('lucide-react'),
    '@/contexts/AuthContext':{useAuth:()=>({user:{id:'synthetic-user'},profile:{id:'synthetic-user',tenant_id:'synthetic-tenant',role:'coach',full_name:'Synthetic Coach',has_seen_tour:true},loading:false,refetchProfile:async()=>{},signOut:async()=>{}})},
    '@/contexts/useTenant':{useTenant:()=>({tenant:React.useContext(TenantFixtureContext),loading:false,refetchTenant:async()=>{model.tenant={...f.tables.tenants[0],current_period_end:f.tables.subscriptions[0].current_period_end};}})},
    '@/hooks/useImpersonation':{useImpersonation:()=>({isImpersonating:false,getImpersonationTenant:()=>null})},
    '@/utils/subdomain':{isAdminSubdomain:()=>false},
    '@/lib/trial-status':moduleFromSource('src/lib/trial-status.ts'),
    '@/lib/billing-plan-selection':moduleFromSource('src/lib/billing-plan-selection.ts'),
    '@/lib/payment-validation':{formatCardExpiryInput:value=>value,validateCreditCard:()=>({valid:false})},
    '@/lib/brazilian-document':{identifyBrazilianDocument:()=>null},
    '@/lib/utils':{cn:(...values)=>values.filter(Boolean).join(' ')},
    '@/contexts/UIContext':{useUI:()=>({setSupportOpen(){}})},
    '@/components/ui/button':{Button:({children,onClick,disabled,className})=>React.createElement('button',{onClick,disabled,className},children)},
    '@/components/ui/card':{Card:({children})=>React.createElement('div',{},children)},
    '@/components/ui/badge':{Badge:({children})=>React.createElement('span',{},children)},
    '@/components/ui/skeleton':{Skeleton:()=>React.createElement('div',{},'Loading synthetic fixture')},
    './SubscriptionCancellationFlow':{SubscriptionCancellationFlow:()=>null},'./ApexContractDialog':{ApexContractDialog:()=>null},
    sonner:{toast:{success(){},error(){},info(){}}},
  };
  dependencies['@/lib/supabase']={supabase:{...f.db,functions:{invoke:async(name,{body})=>{model.apiCalls.push(body.action);return f.invoke(body);}}}};
  let TenantProvider;
  if(realTenantContext){
    dependencies['./AuthContext']=dependencies['@/contexts/AuthContext'];
    dependencies['@/lib/whitelabel']={detectTenant:async()=>null,injectBranding(){},resetBranding(){}};
    Object.assign(dependencies['@/lib/supabase'].supabase,{channel:()=>{
      const channel={callbacks:new Map(),on(event,filter,callback){assert.match(filter.filter,/synthetic-tenant/);channel.callbacks.set(filter.table,callback);return channel;},subscribe(){model.channels.push(channel);return channel;}};return channel;
    },removeChannel:async channel=>{model.channels=model.channels.filter(value=>value!==channel);}});
    const tenantModule=moduleFromSource('src/contexts/TenantContext.tsx',dependencies);
    TenantProvider=tenantModule.TenantProvider;
    dependencies['@/contexts/useTenant']={useTenant:()=>React.useContext(tenantModule.TenantContext)};
  }
  const ProtectedRoute=moduleFromSource('src/components/auth/ProtectedRoute.tsx',dependencies).ProtectedRoute;
  const BlockedPage=moduleFromSource('src/pages/dashboard/BlockedPage.tsx',dependencies).default;
  const SubscriptionManager=moduleFromSource('src/components/dashboard/SubscriptionManager.tsx',dependencies,{setInterval:callback=>{paymentIntervals.set(++intervalId,callback);return intervalId;},clearInterval:id=>paymentIntervals.delete(id)}).SubscriptionManager;
  const root=createRoot(document.getElementById('fixture'));
  const child=component==='blocked'?React.createElement(BlockedPage):component==='billing'?React.createElement(SubscriptionManager):React.createElement(ProtectedRoute,{},React.createElement('div',{'data-testid':'dashboard'},'Synthetic dashboard'));
  const routes=React.createElement(Routes,{},
      React.createElement(Route,{path:'/dashboard',element:child}),
      React.createElement(Route,{path:'/blocked',element:realTenantContext?React.createElement(ProtectedRoute,{},React.createElement(BlockedPage)):React.createElement(BlockedPage)}),
      React.createElement(Route,{path:'/dashboard/billing',element:React.createElement(SubscriptionManager)}));
  const tree=React.createElement(MemoryRouter,{initialEntries:[initialPath],future:{v7_startTransition:true,v7_relativeSplatPath:true}},realTenantContext?React.createElement(TenantProvider,{},routes):routes);
  const render=()=>root.render(React.createElement(TenantFixtureContext.Provider,{value:model.tenant},tree));
  return {model,async mount(){await act(async()=>render());},async refresh(){model.tenant={...f.tables.tenants[0],current_period_end:f.tables.subscriptions[0].current_period_end};await act(async()=>render());},async emitChange(table){assert.equal(model.channels.length,1);await act(async()=>model.channels[0].callbacks.get(table)());},async focus(){await act(async()=>window.dispatchEvent(new dom.window.Event('focus')));},async pollPayment(){assert.equal(paymentIntervals.size,1,'A pending payment must be polled automatically');await act(async()=>{for(const callback of paymentIntervals.values())await callback();});},async click(label){const button=[...document.querySelectorAll('button')].find(button=>button.textContent.includes(label));assert.ok(button,`Missing button: ${label}`);await act(async()=>button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));},async close(){await act(async()=>root.unmount());dom.window.close();},get text(){return document.body.textContent;}};
}
test('backend denies a suspended tenant and permits it after a paid webhook',async()=>{
  const f=suspendedFixture();const guard=activeApiGuard(f);await assert.rejects(guard,error=>error.status===403);
  const webhook=webhookEndpoint(f);const received=await webhook('PAYMENT_RECEIVED');assert.equal(received.http,200,JSON.stringify(received.body));
  await guard();assert.equal(f.tables.tenants[0].status,'active');assert.equal(f.grants.size,1);
  const firstEnd=f.tables.subscriptions[0].current_period_end;
  assert.equal((await webhook('PAYMENT_CONFIRMED')).http,200);assert.equal((await webhook('PAYMENT_RECEIVED')).http,200);
  assert.equal(f.grants.size,1);assert.equal(f.tables.subscriptions[0].current_period_end,firstEnd);
});
test('backend denies expired access even before the expiry cron changes status',async()=>{
  const f=suspendedFixture();Object.assign(f.tables.tenants[0],{status:'active',subscription_status:'active'});
  await assert.rejects(activeApiGuard(f),error=>error.status===403 && /expired/.test(error.message));
});
test('an unauthenticated webhook cannot reactivate access',async()=>{
  const f=suspendedFixture();const response=await webhookEndpoint(f)('PAYMENT_RECEIVED',paid,'evt_unauthorized','invalid-synthetic-token');
  assert.equal(response.http,401);assert.equal(f.grants.size,0);assert.equal(f.tables.tenants[0].status,'suspended');assert.equal(f.tables.asaas_webhook_events.length,0);
});
test('the actual dashboard route renders the blocked screen before payment',async()=>{
  const f=suspendedFixture();const ui=renderUi(f);try{await ui.mount();assert.match(ui.text,/Assinatura pausada/);assert.match(ui.text,/Regularizar assinatura/);assert.ok(!document.querySelector('[data-testid="dashboard"]'));}finally{await ui.close();}
});
test('the actual dashboard route opens after a valid paid confirmation',async()=>{
  const f=suspendedFixture();assert.equal((await webhookEndpoint(f)('PAYMENT_RECEIVED')).http,200);
  const ui=renderUi(f);try{await ui.mount();assert.ok(document.querySelector('[data-testid="dashboard"]'));assert.ok(!ui.text.includes('Assinatura pausada'));}finally{await ui.close();}
});
test('the blocked screen directs back to the dashboard after refreshed paid state',async()=>{
  const f=suspendedFixture();const ui=renderUi(f,'/dashboard','blocked');try{await ui.mount();assert.equal(ui.model.navigation.length,0);assert.equal((await webhookEndpoint(f)('PAYMENT_RECEIVED')).http,200);await ui.refresh();assert.deepEqual(ui.model.navigation,['/dashboard']);}finally{await ui.close();}
});
test('the blocked screen does not reopen a physically suspended tenant with an active financial status',async()=>{
  const f=suspendedFixture();Object.assign(f.tables.tenants[0],{subscription_status:'active'});f.tables.subscriptions[0].current_period_end='2026-03-01T12:00:00Z';
  const ui=renderUi(f,'/dashboard','blocked');try{await ui.mount();assert.equal(ui.model.navigation.length,0);}finally{await ui.close();}
});
test('the real billing screen shows the existing QR and automatically releases only after payment',async()=>{
  const f=suspendedFixture();const provider=billingEndpoint(f);const guard=activeApiGuard(f);
  const ui=renderUi(f,'/dashboard/billing','billing');
  try{
    await ui.mount();assert.match(ui.text,/SYNTHETIC-PIX-CODE/);assert.ok(document.querySelector('img'));
    await ui.click('VERIFICAR AGORA');assert.ok(!ui.text.includes('CONFIRMADO!'));assert.equal(f.grants.size,0);await assert.rejects(guard,error=>error.status===403);
    provider.confirm();await ui.pollPayment();assert.match(ui.text,/PAGAMENTO\s*CONFIRMADO!/);assert.match(ui.text,/ACESSAR PAINEL/);await guard();assert.equal(f.grants.size,1);
    assert.ok(provider.providerCalls.some(url=>url.includes('/payments/pay_synthetic/pixQrCode')));
  }finally{await ui.close();}
  const dashboard=renderUi(f);try{await dashboard.mount();assert.ok(document.querySelector('[data-testid="dashboard"]'));}finally{await dashboard.close();}
});
for(const trigger of ['realtime','focus'])test('the actual tenant context refreshes paid access on '+trigger,async()=>{
  const f=suspendedFixture();const ui=renderUi(f,'/dashboard','route',true);
  try{
    await ui.mount();assert.match(ui.text,/Assinatura pausada/);assert.equal(ui.model.navigation.length,0);
    assert.equal((await webhookEndpoint(f)('PAYMENT_RECEIVED')).http,200);
    if(trigger==='realtime')await ui.emitChange('subscriptions');else await ui.focus();
    assert.deepEqual(ui.model.navigation,['/dashboard']);
  }finally{await ui.close();}
  assert.equal(ui.model.channels.length,0,'Realtime subscriptions must be cleaned up');
});
