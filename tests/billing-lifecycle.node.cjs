// Synthetic fixtures only. Implementation is loaded locally and never included here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourceRoot = process.env.APEX_BILLING_SOURCE;
if (!sourceRoot) throw new Error('Set APEX_BILLING_SOURCE to an authorized local source checkout');
const ts = createRequire(path.join(sourceRoot, 'package.json'))('typescript');
function functions(file, names) {
  const text = fs.readFileSync(path.join(sourceRoot, 'supabase/functions', file), 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const selected = tree.statements.filter(node => names.includes(node.name?.text));
  assert.equal(selected.length, names.length, `Missing implementation seam: ${file}`);
  return selected.map(node => node.getText(tree).replace(/^export /, '')).join('\n');
}
const source = [
  functions('shared/billing-access.ts', ['money','decideAccess','isPaidPaymentStatus']),
  functions('shared/subscription-payments.ts', ['paymentConfirmedAt','applySubscriptionPayment']),
  functions('shared/pix-automatic.ts', ['isPixAutomaticLocalId','toPixAutomaticLocalId','toPixAutomaticProviderId','getPixAutomaticQrCode','findPixAutomaticAuthorizationByContract']),
  functions('shared/pix-automatic-payments.ts', ['listPixAutomaticPayments','preparePixAutomaticCheckout']),
  functions('shared/manual-pix-cycles.ts', ['brazilDate','ensureManualPixCycle']),
  functions('asaas-manager/index.ts', ['syncConfirmedPayment']),
  functions('asaas-webhook/index.ts', ['findSubscriptionByAsaasId','findPendingSubscriptionByCustomer','resolvePaymentSubscription','handlePaymentConfirmed','handlePaymentOverdue','getPaymentAttentionLabel','notifyPaymentAttention']),
].join('\n');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const instant = '2026-02-01T12:00:00Z';
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return new Date(instant).getTime(); } }
function fixture() {
  const tables = {
    subscriptions: [{id:'synthetic-sub',tenant_id:'synthetic-tenant',plan_id:'synthetic-plan',asaas_id:'pay_synthetic',status:'pending',billing_type:'ANUAL_PIX_AUTOMATIC',current_period_end:instant,last_processed_payment_id:null}],
    billing_plans: [{id:'synthetic-plan',price_monthly:249.99,price_yearly:2999.88}],
    tenants: [{id:'synthetic-tenant',status:'suspended',subscription_status:'blocked'}],
    asaas_customers: [{tenant_id:'synthetic-tenant',asaas_id:'cus_synthetic'}],
    asaas_webhook_events: [], asaas_payment_effects: [], tenant_purchases: [], notifications: [], profiles: [{id:'synthetic-user',tenant_id:'synthetic-tenant',role:'coach'}], asaas_pix_billing_cycles: [],
  };
  const grants = new Set(); let rowSequence = 0;
  const db = {
    auth: {getUser: async () => ({data:{user:{id:'synthetic-user'}},error:null})},
    from(table) {
      tables[table] ||= [];
      let predicates=[], patch, inserted;
      const query = {
        select() {return query;}, order(){return query;}, limit(){return query;},
        eq(k,v){predicates.push(row=>row[k]===v);return query;}, neq(k,v){predicates.push(row=>row[k]!==v);return query;},
        not(k,op,v){predicates.push(row=>op==='is'?row[k]!==v:true);return query;},
        in(k,vs){predicates.push(row=>vs.includes(row[k]));return query;},
        like(k,v){predicates.push(row=>String(row[k]||'').startsWith(v.slice(0,-1)));return query;},
        or(filter){predicates.push(row=>filter.split(',').some(clause=>{const [k,v]=clause.split('.eq.');return row[k]===v;}));return query;},
        update(value){patch=value;return query;}, insert(value){inserted=Array.isArray(value)?value:[value];return query;},
        execute(single=false){
          let affectedRows;
          if(inserted){
            const unique = table==='asaas_webhook_events'?'provider_event_id':table==='asaas_payment_effects'?'payment_id':null;
            if(unique && tables[table].some(row=>row[unique]===inserted[0][unique])) return {data:null,error:{code:'23505'}};
            if(table==='asaas_pix_billing_cycles' && tables[table].some(row=>row.subscription_id===inserted[0].subscription_id&&row.cycle_date===inserted[0].cycle_date)) return {data:null,error:{code:'23505'}};
            if(table==='notifications' && inserted.some(row=>Object.keys(row).some(k=>!['user_id','tenant_id','type','content','data'].includes(k)))) return {data:null,error:{code:'PGRST204'}};
            inserted.forEach(row=>{if(!row.id)row.id='synthetic-row-'+(++rowSequence);});
            affectedRows=inserted;
            tables[table].push(...inserted);inserted=null;
          }
          const rows=(affectedRows || tables[table]).filter(row=>predicates.every(predicate=>predicate(row)));
          if(patch) rows.forEach(row=>Object.assign(row,patch));
          return {data:single?(rows[0]?{...rows[0]}:null):rows.map(row=>({...row})),error:null};
        },
        async maybeSingle(){return query.execute(true);}, async single(){return query.execute(true);},
        then(resolve,reject){return Promise.resolve(query.execute()).then(resolve,reject);},
      };return query;
    },
    async rpc(name,args){
      assert.equal(name,'apply_asaas_subscription_payment');
      const sub=tables.subscriptions.find(row=>row.id===args.p_subscription_id);
      if(grants.has(args.p_payment_id)||sub.last_processed_payment_id===args.p_payment_id) return {data:{applied:false,reason:'already_applied'},error:null};
      grants.add(args.p_payment_id);
      const end=new Date(Math.max(new Date(sub.current_period_end).getTime(),new Date(args.p_paid_at).getTime()));end.setUTCMonth(end.getUTCMonth()+args.p_access_months);
      Object.assign(sub,{status:'active',current_period_end:end.toISOString(),last_processed_payment_id:args.p_payment_id});
      Object.assign(tables.tenants[0],{status:'active',subscription_status:'active'});
      return {data:{applied:true,current_period_end:sub.current_period_end},error:null};
    },
  };
  const context=vm.createContext({ Date:FixedDate, Intl, console:{log(){},warn(){}}, Error, Set,
    PAID_PAYMENT_STATUSES:new Set(['RECEIVED','CONFIRMED','RECEIVED_IN_CASH']),
    createCommissionForPayment:async()=>{},sendConfirmationEmail:async()=>{},
    findPaymentTenantId:async()=> 'synthetic-tenant',getAsaasCustomerContact:async()=>null,
    syncTenantFromPlan:async(_,tenantId,planId,status)=>{tables.tenants[0].subscription_status=status;},
    fetch:async()=>{throw new Error('Unexpected network request in synthetic test');},
  });vm.runInContext(compiled,context);
  return {tables,db,context,grants};
}
const paid = {id:'pay_synthetic',customer:'cus_synthetic',status:'RECEIVED',value:249.99,paymentDate:'2026-02-01'};
function managerHandler(f, remoteFetch) {
  const file=path.join(sourceRoot,'supabase/functions/asaas-manager/index.ts');
  const text=fs.readFileSync(file,'utf8');const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const source=tree.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(tree)).join('\n');
  class HttpError extends Error {constructor(message,status=400){super(message);this.status=status;}}
  Object.assign(f.context,{HttpError,Request,Response,AbortController,setTimeout,clearTimeout,
    Deno:{env:{get:()=>undefined}}, isPixAutomaticEnabled:()=>true,
    createClient:()=>f.db,getCorsHeaders:()=>({}),getClientIp:()=> '198.51.100.1',
    requireUser:async()=>({user:{id:'synthetic-user'},profile:{tenant_id:'synthetic-tenant',role:'coach',is_tenant_admin:true}}),
    getErrorStatus:error=>error.status||500,getErrorMessage:error=>error.message||'unexpected',
    fetch:remoteFetch,console:{log(){},warn(){},error(){}},serve:handler=>{f.handler=handler;},
  });
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,f.context);
  return async id=>{
    const response=await f.handler(new Request('https://synthetic.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({action:'get-payment-status',payload:{paymentId:id}})}));
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
}
test('real status endpoint does not treat ACTIVE bank authorization as money',async()=>{
  const f=fixture();f.tables.subscriptions[0].asaas_id='pau_auth_synthetic';
  const check=managerHandler(f,async url=>new Response(JSON.stringify(String(url).includes('/authorizations/')?{id:'auth_synthetic',customerId:'cus_synthetic',status:'ACTIVE',paymentCreationMode:'SUBSCRIPTION',subscriptionId:'sub_synthetic'}:{data:[]}),{status:200}));
  const result=await check('pau_auth_synthetic');assert.equal(result.confirmed,false);assert.equal(result.authorizationStatus,'ACTIVE');assert.equal(f.grants.size,0);
});
test('real status endpoint polling cannot credit an old receipt twice',async()=>{
  const f=fixture();const check=managerHandler(f,async()=>new Response(JSON.stringify(paid),{status:200}));
  await check(paid.id);await check(paid.id);assert.equal(f.grants.size,1);
});
test('real status endpoint rejects access for an insufficient received amount',async()=>{
  const f=fixture();const check=managerHandler(f,async()=>new Response(JSON.stringify({...paid,value:1}),{status:200}));
  const result=await check(paid.id);assert.equal(result.paymentReceived,true);assert.equal(result.confirmed,false);assert.equal(f.grants.size,0);
});
test('poll and webhook apply the same payment once, including concurrent requests',async()=>{
  const f=fixture();await Promise.all([f.context.syncConfirmedPayment(f.db,'pay_synthetic',false,paid),f.context.handlePaymentConfirmed(f.db,paid,'PAYMENT_RECEIVED')]);
  assert.equal(f.grants.size,1);assert.equal(f.tables.subscriptions[0].current_period_end.slice(0,10),'2026-03-01');
});
test('an old receipt cannot reopen blocked access',async()=>{
  const f=fixture();f.tables.subscriptions[0].last_processed_payment_id=paid.id;
  await f.context.syncConfirmedPayment(f.db,'pay_synthetic',false,paid);assert.equal(f.tables.tenants[0].subscription_status,'blocked');
});
test('renewal for an active mandate resolves and extends access',async()=>{
  const f=fixture();Object.assign(f.tables.subscriptions[0],{asaas_id:'pau_auth_synthetic',pix_automatic_authorization_id:'auth_synthetic',status:'active'});
  await f.context.handlePaymentConfirmed(f.db,{...paid,id:'pay_renewal',pixAutomaticAuthorizationId:'auth_synthetic'},'PAYMENT_RECEIVED');assert.equal(f.grants.size,1);
});
test('overdue installment resolves an active mandate',async()=>{
  const f=fixture();Object.assign(f.tables.subscriptions[0],{asaas_id:'pau_auth_synthetic',pix_automatic_authorization_id:'auth_synthetic',status:'active'});
  await f.context.handlePaymentOverdue(f.db,{...paid,id:'pay_overdue',pixAutomaticAuthorizationId:'auth_synthetic',status:'OVERDUE'});assert.equal(f.tables.tenants[0].subscription_status,'past_due');
});
test('bank authorization alone and insufficient money do not grant access',async()=>{
  const f=fixture();await f.context.applySubscriptionPayment(f.db,f.tables.subscriptions[0],{...paid,status:'ACTIVE'});
  await f.context.applySubscriptionPayment(f.db,f.tables.subscriptions[0],{...paid,value:1});assert.equal(f.grants.size,0);
});
test('automatic checkout preserves the mandate and only uses an existing installment',async()=>{
  const f=fixture();const calls=[];const auth={id:'auth_synthetic',status:'ACTIVE',paymentCreationMode:'SUBSCRIPTION',subscriptionId:'sub_synthetic',customerId:'cus_synthetic'};
  const checkout=await f.context.preparePixAutomaticCheckout(auth,async path=>{calls.push(path);return path.includes('paymentInstructions')?{data:[]}:path.includes('pixQrCode')?{payload:'synthetic-qr'}:{data:[{id:'pay_pending',customer:'cus_synthetic',subscription:'sub_synthetic',status:'PENDING',dueDate:'2026-03-01'}]};});
  assert.equal(checkout.id,'pau_auth_synthetic');assert.equal(checkout.firstPaymentId,'pay_pending');assert.ok(!calls.includes('/payments'));
});
test('incompatible manual mandate is not silently presented as a new automatic subscription',async()=>{
  const f=fixture();await assert.rejects(()=>f.context.preparePixAutomaticCheckout({id:'auth_synthetic',status:'ACTIVE',paymentCreationMode:'MANUAL'},async()=>({data:[]})));
});
test('payment attention notification matches the real supported columns',async()=>{
  const f=fixture();await f.context.notifyPaymentAttention(f.db,'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',paid,()=>{});assert.equal(f.tables.notifications.length,1);
});
test('manual recurring cycle creates exactly one linked installment under concurrency',async()=>{
  const f=fixture();const sub={...f.tables.subscriptions[0],plan:{price_monthly:249.99},pix_automatic_authorization_id:'auth_synthetic'};const creates=[];
  const request=async(path,init)=>{
    if(path.includes('/authorizations/'))return {id:'auth_synthetic',customerId:'cus_synthetic',status:'ACTIVE',paymentCreationMode:'MANUAL',frequency:'MONTHLY',value:249.99};
    if(!init)return {data:[]};const body=JSON.parse(init.body);creates.push(body);return {id:'pay_cycle',...body};
  };
  await Promise.all([f.context.ensureManualPixCycle(f.db,sub,request),f.context.ensureManualPixCycle(f.db,sub,request)]);
  assert.equal(creates.length,1);assert.equal(creates[0].pixAutomaticAuthorizationId,'auth_synthetic');assert.equal(creates[0].value,249.99);
});

test('a provider installment recovers a lost local cycle without a new charge',async()=>{
  const f=fixture();const sub={...f.tables.subscriptions[0],plan:{price_monthly:249.99},pix_automatic_authorization_id:'auth_synthetic'};
  f.tables.asaas_pix_billing_cycles.push({subscription_id:sub.id,cycle_date:'2026-02-01',status:'unknown'});
  let posts=0;const request=async(path,init)=>{
    if(path.includes('/authorizations/'))return {id:'auth_synthetic',customerId:'cus_synthetic',status:'ACTIVE',paymentCreationMode:'MANUAL',frequency:'MONTHLY',value:249.99};
    if(init){posts++;throw new Error('Unexpected duplicate charge');}
    return {data:[{id:'pay_recovered',customer:'cus_synthetic',externalReference:'APEX-CYCLE-synthetic-tenant-2026-02-01',dueDate:'2026-02-08',pixAutomaticAuthorizationId:'auth_synthetic'}]};
  };
  const result=await f.context.ensureManualPixCycle(f.db,sub,request);
  assert.equal(result.action,'existing');assert.equal(posts,0);
  assert.equal(f.tables.asaas_pix_billing_cycles[0].status,'ready');
  assert.equal(f.tables.subscriptions[0].pix_automatic_payment_id,'pay_recovered');
});
test('an ambiguous provider failure is not retried as a second charge',async()=>{
  const f=fixture();const sub={...f.tables.subscriptions[0],plan:{price_monthly:249.99},pix_automatic_authorization_id:'auth_synthetic'};
  let posts=0;const request=async(path,init)=>{
    if(path.includes('/authorizations/'))return {id:'auth_synthetic',customerId:'cus_synthetic',status:'ACTIVE',paymentCreationMode:'MANUAL',frequency:'MONTHLY',value:249.99};
    if(!init)return {data:[]};posts++;throw new Error('Synthetic connection lost after provider request');
  };
  await assert.rejects(f.context.ensureManualPixCycle(f.db,sub,request));
  const retry=await f.context.ensureManualPixCycle(f.db,sub,request);
  assert.equal(posts,1);assert.equal(retry.reason,'cycle_already_claimed');assert.equal(f.tables.asaas_pix_billing_cycles[0].status,'unknown');
});

module.exports = {fixture, functions, managerHandler, paid, ts, sourceRoot, FixedDate};
