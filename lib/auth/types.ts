export type UserType = 'guest' | 'regular'

export interface AuthUser {
  id: string
  email: string
  type: UserType
}

export interface LoginActionState {
  status: 'idle' | 'invalid_data' | 'failed' | 'success'
}

export interface RegisterActionState {
  status: 'idle' | 'invalid_data' | 'failed' | 'success'
}
