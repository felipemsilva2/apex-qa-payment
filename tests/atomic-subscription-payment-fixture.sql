-- Run only in an explicitly authorized database with the billing migrations applied.
-- Synthetic rows remain inside this transaction and are rolled back.
BEGIN;
DO $test$
DECLARE
  tenant_uuid uuid := '00000000-0000-4000-8000-000000001001';
  plan_uuid uuid := '00000000-0000-4000-8000-000000001002';
  sub_uuid uuid := '00000000-0000-4000-8000-000000001003';
  result jsonb;
  first_end timestamptz;
  second_end timestamptz;
BEGIN
  INSERT INTO public.tenants(id,subdomain,business_name,status,subscription_status,plan_tier)
    VALUES(tenant_uuid,'synthetic-billing-regression-1001','Synthetic billing regression','suspended','blocked','gym');
  INSERT INTO public.billing_plans(id,name,price_monthly,price_yearly,plan_tier)
    VALUES(plan_uuid,'Synthetic billing regression',249.99,2999.88,'gym');
  INSERT INTO public.subscriptions(id,tenant_id,plan_id,asaas_id,status,billing_type,current_period_end)
    VALUES(sub_uuid,tenant_uuid,plan_uuid,'pau_synthetic','pending','ANUAL_PIX_AUTOMATIC',now());
  UPDATE public.tenants SET subscription_test_blocked=true,trial_end=now()-interval '1 day' WHERE id=tenant_uuid;
  result := public.apply_asaas_subscription_payment(sub_uuid,'pay_synthetic_first',249.99,1,now());
  IF result->>'applied' <> 'true' THEN RAISE EXCEPTION 'First paid cycle was not applied'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=tenant_uuid AND status='active'
    AND subscription_status='active' AND subscription_test_blocked=false AND trial_end IS NULL) THEN
    RAISE EXCEPTION 'Paid confirmation did not clear all tenant access locks';
  END IF;
  SELECT current_period_end INTO first_end FROM public.subscriptions WHERE id=sub_uuid;
  IF first_end <= now() OR (SELECT status FROM public.subscriptions WHERE id=sub_uuid) <> 'active' THEN
    RAISE EXCEPTION 'Paid confirmation did not restore a current subscription';
  END IF;
  result := public.apply_asaas_subscription_payment(sub_uuid,'pay_synthetic_first',249.99,1,now());
  SELECT current_period_end INTO second_end FROM public.subscriptions WHERE id=sub_uuid;
  IF result->>'applied' <> 'false' OR first_end <> second_end THEN RAISE EXCEPTION 'Duplicate payment extended access'; END IF;
  UPDATE public.subscriptions SET status='suspended' WHERE id=sub_uuid;
  UPDATE public.tenants SET subscription_status='blocked',status='suspended' WHERE id=tenant_uuid;
  result := public.apply_asaas_subscription_payment(sub_uuid,'pay_synthetic_first',249.99,1,now());
  IF (SELECT subscription_status FROM public.tenants WHERE id=tenant_uuid) <> 'blocked' THEN RAISE EXCEPTION 'Old payment reopened access'; END IF;
  result := public.apply_asaas_subscription_payment(sub_uuid,'pay_synthetic_renewal',249.99,1,now());
  IF result->>'applied' <> 'true' OR (SELECT status FROM public.tenants WHERE id=tenant_uuid) <> 'active' THEN RAISE EXCEPTION 'New renewal did not reactivate tenant'; END IF;
  IF (SELECT count(*) FROM public.asaas_subscription_payment_grants WHERE tenant_id=tenant_uuid) <> 2 THEN RAISE EXCEPTION 'Grant count incorrect'; END IF;
  -- Replay of a late first confirmation cannot start a fresh month today.
  DELETE FROM public.asaas_subscription_payment_grants WHERE tenant_id=tenant_uuid;
  UPDATE public.subscriptions SET current_period_end=now(),last_processed_payment_id=NULL WHERE id=sub_uuid;
  result := public.apply_asaas_subscription_payment(sub_uuid,'pay_synthetic_late',249.99,1,now()-interval '40 days');
  IF result->>'active' <> 'false' OR (SELECT subscription_status FROM public.tenants WHERE id=tenant_uuid) <> 'blocked' THEN RAISE EXCEPTION 'Late replay granted fresh access'; END IF;
  IF has_function_privilege('anon','public.apply_asaas_subscription_payment(uuid,text,numeric,integer,timestamptz)','EXECUTE')
    OR has_function_privilege('authenticated','public.apply_asaas_subscription_payment(uuid,text,numeric,integer,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'Public callers may grant access'; END IF;
END;
$test$;
ROLLBACK;
SELECT jsonb_build_object('synthetic_atomic_payment_checks','PASS','production_writes','ROLLED BACK');
