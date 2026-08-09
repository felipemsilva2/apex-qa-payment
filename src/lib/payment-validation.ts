export type CardDetails = {
    number: string
    name: string
    expiry: string
    cvv: string
}

export type NormalizedCreditCard = {
    holderName: string
    number: string
    expiryMonth: string
    expiryYear: string
    ccv: string
}

export type CardValidationResult =
    | { valid: true; value: NormalizedCreditCard }
    | { valid: false; error: string }

export const formatCardExpiryInput = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 6)
    return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits
}

const passesLuhnCheck = (number: string) => {
    let sum = 0
    let shouldDouble = false

    for (let index = number.length - 1; index >= 0; index -= 1) {
        let digit = Number(number[index])
        if (shouldDouble) {
            digit *= 2
            if (digit > 9) digit -= 9
        }
        sum += digit
        shouldDouble = !shouldDouble
    }

    return sum % 10 === 0
}

const parseExpiry = (expiry: string, now: Date) => {
    const digits = expiry.replace(/\D/g, '')
    if (digits.length !== 4 && digits.length !== 6) return null

    const month = Number(digits.slice(0, 2))
    const yearDigits = digits.slice(2)
    const year = Number(yearDigits.length === 2 ? `20${yearDigits}` : yearDigits)
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return null

    const currentMonth = now.getFullYear() * 12 + now.getMonth()
    const expiryMonth = year * 12 + (month - 1)
    if (expiryMonth < currentMonth) return null

    return {
        month: String(month).padStart(2, '0'),
        year: String(year),
    }
}

export const validateCreditCard = (details: CardDetails, now = new Date()): CardValidationResult => {
    const number = details.number.replace(/\D/g, '')
    if (number.length < 13 || number.length > 19 || !passesLuhnCheck(number)) {
        return { valid: false, error: 'Número do cartão inválido. Confira os dígitos.' }
    }

    const holderName = details.name.trim()
    if (holderName.length < 2) {
        return { valid: false, error: 'Informe o nome impresso no cartão.' }
    }

    const parsedExpiry = parseExpiry(details.expiry, now)
    if (!parsedExpiry) {
        return { valid: false, error: 'Validade inválida ou expirada. Use MM/AA.' }
    }

    const ccv = details.cvv.replace(/\D/g, '')
    if (ccv.length < 3 || ccv.length > 4) {
        return { valid: false, error: 'CVV inválido. Informe 3 ou 4 dígitos.' }
    }

    return {
        valid: true,
        value: {
            holderName,
            number,
            expiryMonth: parsedExpiry.month,
            expiryYear: parsedExpiry.year,
            ccv,
        },
    }
}
