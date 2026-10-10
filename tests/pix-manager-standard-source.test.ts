import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = process.env.APEX_BILLING_SOURCE || process.cwd()

const managerSource = readFileSync(
  join(sourceRoot, 'supabase/functions/asaas-manager/index.ts'),
  'utf8',
)

const onboardingSource = readFileSync(
  join(sourceRoot, 'supabase/functions/complete-onboarding/index.ts'),
  'utf8',
)

describe('Pix management', () => {
  it('keeps Pix Automático scoped to eligible monthly flows and explicit annual tenants', () => {
    const start = managerSource.indexOf("normalizedAction === 'create-subscription'")
    const end = managerSource.indexOf("normalizedAction === 'cancel-subscription'")
    const createSubscriptionSource = managerSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(managerSource).toContain('isPixAutomaticEnabled(IS_PROD)')
    expect(createSubscriptionSource).toContain("PIX_AUTOMATIC_ENABLED && billingCycle === 'MENSAL'")
    expect(createSubscriptionSource).toContain("tenantData?.pix_automatic_annual_enabled === true")
    expect(createSubscriptionSource).toContain("frequency: annualPixAutomatic ? 'MONTHLY'")
    expect(createSubscriptionSource).toContain('finishDate')
    expect(createSubscriptionSource).toContain('/pix/automatic/authorizations')
    expect(createSubscriptionSource).toContain('findPixAutomaticAuthorizationByContract')
    expect(createSubscriptionSource).toContain('getPixAutomaticQrCode')
    expect(createSubscriptionSource).toContain('authorizationData.immediateQrCode')
    expect(createSubscriptionSource).toContain('immediateQrCode')
    expect(createSubscriptionSource).toContain('originalValue: value')
    expect(createSubscriptionSource).toContain('expirationSeconds: PIX_AUTOMATIC_QR_EXPIRATION_SECONDS')
    expect(createSubscriptionSource).toContain("billingType: 'PIX'")
    expect(createSubscriptionSource).toContain("paymentCreationMode: 'SUBSCRIPTION'")
    expect(createSubscriptionSource).toContain('preparePixAutomaticCheckout')
    expect(createSubscriptionSource).not.toContain('retrying as standard Pix')
    expect(createSubscriptionSource).toContain('`${ASAAS_API_URL}/payments`')
  })

  it('supports cancellation and history for one-off pay_ payments', () => {
    expect(managerSource).toContain("subscriptionId.startsWith('pay_')")
    expect(managerSource).toContain('`${ASAAS_API_URL}/payments/${subscriptionId}`')
    expect(managerSource).toContain('const responseData = isOneOffPayment ? { data: [asaasData] } : asaasData;')
    expect(managerSource).toContain("update({ status: 'canceled'")
    expect(managerSource).toContain("subscription_status: keepTrialAccess || keepPaidAccess")
    expect(managerSource).not.toContain("status: 'cancelled'")
  })

  it('charges the full selected contract when standard Pix is one-off', () => {
    expect(managerSource).toContain("billingCycle === 'ANUAL'")
    expect(managerSource).toContain("billingCycle === 'TRIMESTRAL'")
    expect(managerSource).toContain('monthlyPrice * 3')
    expect(onboardingSource).toContain('isCard ? getPlanMonthlyPrice(selectedPlan) : getPlanMonthlyPrice(selectedPlan) * 3')
  })
})
