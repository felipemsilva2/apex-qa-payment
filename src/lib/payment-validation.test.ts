import { describe, expect, it } from 'vitest'
import {
    formatCardExpiryInput,
    validateCreditCard,
} from './payment-validation'

describe('trial payment card validation', () => {
    it('normalizes a valid card and two-digit expiry year for Asaas', () => {
        const result = validateCreditCard(
            {
                number: '4111 1111 1111 1111',
                name: 'TEST USER',
                expiry: '12/30',
                cvv: '123',
            },
            new Date('2026-08-05T12:00:00Z'),
        )

        expect(result).toEqual({
            valid: true,
            value: {
                holderName: 'TEST USER',
                number: '4111111111111111',
                expiryMonth: '12',
                expiryYear: '2030',
                ccv: '123',
            },
        })
    })

    it('keeps a four-digit expiry year intact instead of prefixing 20 twice', () => {
        const result = validateCreditCard(
            {
                number: '4111111111111111',
                name: 'TEST USER',
                expiry: '12/2030',
                cvv: '123',
            },
            new Date('2026-08-05T12:00:00Z'),
        )

        expect(result.valid).toBe(true)
        if (result.valid) expect(result.value.expiryYear).toBe('2030')
    })

    it('rejects invalid card numbers, expiry dates and CVVs', () => {
        expect(validateCreditCard({ number: '4111111111111112', name: 'TEST USER', expiry: '12/30', cvv: '123' })).toMatchObject({ valid: false })
        expect(validateCreditCard({ number: '4111111111111111', name: 'TEST USER', expiry: '13/30', cvv: '123' })).toMatchObject({ valid: false })
        expect(validateCreditCard({ number: '4111111111111111', name: 'TEST USER', expiry: '01/25', cvv: '123' }, new Date('2026-08-05T12:00:00Z'))).toMatchObject({ valid: false })
        expect(validateCreditCard({ number: '4111111111111111', name: 'TEST USER', expiry: '12/30', cvv: '12' })).toMatchObject({ valid: false })
    })

    it('accepts and formats the optional four-digit year input', () => {
        expect(formatCardExpiryInput(' 12/2030 ')).toBe('12/2030')
        expect(formatCardExpiryInput('12/30')).toBe('12/30')
    })
})
