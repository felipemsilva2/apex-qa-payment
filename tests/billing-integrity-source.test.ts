import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = process.env.APEX_BILLING_SOURCE || process.cwd()

const managerSource = readFileSync(
  join(sourceRoot, 'supabase/functions/asaas-manager/index.ts'),
  'utf8',
)
const webhookSource = readFileSync(
  join(sourceRoot, 'supabase/functions/asaas-webhook/index.ts'),
  'utf8',
)
const adminSource = readFileSync(
  join(sourceRoot, 'supabase/functions/admin-manage-subscription/index.ts'),
  'utf8',
)
const reconcileSource = readFileSync(
  join(sourceRoot, 'supabase/functions/asaas-reconcile/index.ts'),
  'utf8',
)
const atomicPaymentSource = readFileSync(join(sourceRoot, 'supabase/migrations/20261010040000_atomic_subscription_payments.sql'), 'utf8')

const expiryMigrationSource = readFileSync(
  join(sourceRoot, 'supabase/migrations/20260803190000_fix_subscription_expiry_blocking.sql'),
  'utf8',
)

describe('billing integrity boundaries', () => {
  it('does not pre-grant paid access before a payment is confirmed', () => {
    const createSubscription = managerSource.slice(
      managerSource.indexOf("if (normalizedAction === 'create-subscription')"),
      managerSource.indexOf("if (normalizedAction === 'cancel-subscription')"),
    )

    expect(createSubscription).toContain('const accessPeriodEnd = isTrialable')
    expect(createSubscription).toContain('current_period_end: accessPeriodEnd.toISOString()')
    expect(createSubscription).not.toContain('periodEndDate.setMonth(periodEndDate.getMonth() + contractDuration)')
  })

  it('keeps an existing trial valid while Pix or card checkout is pending', () => {
    const createSubscription = managerSource.slice(
      managerSource.indexOf("if (normalizedAction === 'create-subscription')"),
      managerSource.indexOf("if (normalizedAction === 'cancel-subscription')"),
    )

    expect(createSubscription).toContain("const isExistingTrial = !isTrialBlocked")
    expect(createSubscription).toContain("const accessPeriodEnd = isTrialable")
    expect(createSubscription).toContain("isExistingTrial && existingTrialEnd")
    expect(createSubscription).toContain("subscription_status: isTrialable || isExistingTrial ? 'trialing' : 'pending'")
    expect(createSubscription).toContain('Preserve the existing trial boundary until the payment webhook')
    expect(createSubscription).not.toContain('updatePayload.trial_end = null')
    expect(createSubscription).not.toContain('updatePayload.is_complimentary = false')
  })

  it('claims one business effect per Asaas payment, not only per webhook event', () => {
    expect(webhookSource).toContain('claimPaymentEffect')
    expect(webhookSource).toContain('finalizePaymentEffect')
    expect(webhookSource).toContain('payment_id: paymentId')
    expect(webhookSource).toContain('applySubscriptionPayment')
    expect(managerSource).toContain('applySubscriptionPayment')
    expect(atomicPaymentSource).toContain('FOR UPDATE')
    expect(atomicPaymentSource).toContain('ON CONFLICT (payment_id) DO NOTHING')
  })

  it('clears trial markers when a paid subscription is confirmed', () => {
    expect(webhookSource).toContain('tenantUpdate.trial_end = null')
    expect(webhookSource).toContain('tenantUpdate.is_complimentary = false')
    expect(webhookSource).toContain('tenantUpdate.subscription_test_blocked = false')
    expect(atomicPaymentSource).toContain('subscription_test_blocked = false')
    expect(atomicPaymentSource).toContain('current_period_end = end_at')
    expect(managerSource).toContain('applySubscriptionPayment')
  })

  it('does not let a stale test block override a confirmed active subscription', () => {
    const authSource = readFileSync(
      join(sourceRoot, 'supabase/functions/shared/auth.ts'),
      'utf8',
    )
    expect(authSource).toContain('tenant.subscription_test_blocked === true && subscriptionStatus !== "active"')
  })

  it('does not report an admin mutation as successful when tenant sync fails', () => {
    const tenantSync = adminSource.slice(
      adminSource.indexOf("const { error: tenantUpdateError }"),
      adminSource.indexOf("return new Response", adminSource.indexOf("const { error: tenantUpdateError }")),
    )
    expect(tenantSync).toContain('if (tenantUpdateError) throw tenantUpdateError')
  })

  it('prioritizes a canceled Asaas subscription over a paid historical installment', () => {
    const classifier = reconcileSource.slice(
      reconcileSource.indexOf('function classifyRemoteStatus'),
      reconcileSource.indexOf('async function syncTenantFromPlan'),
    )
    expect(classifier.indexOf('CANCELED_STATUSES.has(subscriptionStatus)')).toBeLessThan(
      classifier.indexOf('PAID_STATUSES.has(paymentStatus)'),
    )
  })

  it('preserves a normal trial when the provider sends a cancellation event', () => {
    expect(webhookSource).toContain('function hasActiveTenantTrial')
    expect(webhookSource).toContain('subscription_status, trial_end, is_complimentary')
    expect(webhookSource).toContain('hasActiveTenantTrial(tenant) || isActiveComplimentaryTrial(tenant)')
  })

  it('treats an inactive complimentary-trial subscription as preserved trial access', () => {
    expect(reconcileSource).toContain('"INACTIVE"')
    expect(reconcileSource).toContain('isActiveComplimentaryTrial(subscription.tenants)')
    expect(reconcileSource).toContain('complimentaryTrialPreserved')
  })

  it('does not reactivate an expired local period from an active Asaas parent', () => {
    expect(reconcileSource).toContain('expiredLocalPeriodNeedsManualReview')
    expect(reconcileSource).toContain('expired_local_period_requires_payment_confirmation')
  })

  it('keeps a valid manual access period authoritative over a pending payment row', () => {
    expect(reconcileSource).toContain('manualAccessIsAuthoritative')
  })

  it('does not let a stale trial marker override a future paid access period', () => {
    expect(expiryMigrationSource).toContain('COALESCE(latest.current_period_end, t.trial_end) <= now()')
    expect(expiryMigrationSource).not.toContain('t.trial_end <= now()\n        AND (t.subscription_status = \'trialing\' OR t.is_complimentary = true)')
  })
})
