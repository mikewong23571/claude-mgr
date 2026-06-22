import { z } from 'zod'
import { GatewayError } from '../errors.js'
import { readJson } from './responses.js'

const optionalString = z.unknown().optional().transform(value =>
  typeof value === 'string' ? value : undefined,
)

const nullableStringForCreate = z.unknown().optional().transform(value =>
  typeof value === 'string' ? value : null,
)

const optionalNullableString = z.unknown().optional().transform(value =>
  value === null || typeof value === 'string' ? value : undefined,
)

const optionalBoolean = z.unknown().optional().transform(value =>
  typeof value === 'boolean' ? value : undefined,
)

const optionalNumber = z.unknown().optional().transform(value =>
  typeof value === 'number' ? value : undefined,
)

const userRole = z.enum(['owner', 'admin', 'viewer'])

export const OAuthCallbackBody = z.object({
  code: z.string(),
  state: z.string(),
})

export const LoginBody = z.object({
  username: z.string(),
  password: z.string(),
})

export const ChangePasswordBody = z.object({
  current_password: z.string(),
  new_password: z.string(),
})

export const CreateUserBody = z.object({
  username: z.string(),
  display_name: nullableStringForCreate,
  role: userRole,
  password: z.string(),
  enabled: optionalBoolean,
})

export const UpdateUserBody = z.object({
  username: optionalString,
  display_name: optionalNullableString,
  role: userRole.optional(),
  enabled: optionalBoolean,
})

export const ResetUserPasswordBody = z.object({
  password: z.string(),
})

export const CreatePoolBody = z.object({
  id: z.string(),
  name: z.string(),
  purpose: nullableStringForCreate,
})

export const UpdatePoolBody = z.object({
  name: optionalString,
  purpose: optionalNullableString,
})

export const AddPoolMemberBody = z.object({
  account_uuid: z.string(),
  priority: optionalNumber,
  enabled: optionalBoolean,
})

export const UpdatePoolMemberBody = z.object({
  priority: optionalNumber,
  enabled: optionalBoolean,
})

export const CreateClientBody = z.object({
  id: z.string(),
  name: z.string(),
  enabled: optionalBoolean,
  default_pool_id: nullableStringForCreate,
})

export const CreateClientTokenBody = z.object({
  name: z.string(),
})

export const UpdateClientBody = z.object({
  name: optionalString,
  enabled: optionalBoolean,
  default_pool_id: optionalNullableString,
})

export const UpdateAccountBody = z.object({
  enabled: optionalBoolean,
})

const validationMessages = new Map<z.ZodType, string>([
  [OAuthCallbackBody, 'code and state are required'],
  [LoginBody, 'username and password are required'],
  [ChangePasswordBody, 'current_password and new_password are required'],
  [CreateUserBody, 'username, role, and password are required'],
  [ResetUserPasswordBody, 'password is required'],
  [CreatePoolBody, 'id and name are required'],
  [AddPoolMemberBody, 'account_uuid is required'],
  [CreateClientBody, 'id and name are required'],
  [CreateClientTokenBody, 'name is required'],
])

export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const body = await readJson(request)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new GatewayError(
      'gateway_validation_error',
      validationMessages.get(schema) ?? 'Invalid request body',
      400,
    )
  }
  return parsed.data
}
