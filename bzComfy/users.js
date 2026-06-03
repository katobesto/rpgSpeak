/**
 * bzComfy — User management
 * Stores users in bzComfy/users.json with scrypt-hashed passwords.
 * No external dependencies — uses Node.js built-in crypto.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const USERS_FILE = path.join(__dirname, 'users.json')

// ── Password helpers ──────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const hashBuf   = Buffer.from(hash, 'hex')
  const inputHash = scryptSync(password, salt, 64)
  return timingSafeEqual(hashBuf, inputHash)
}

// ── Storage ───────────────────────────────────────────────────────────────────

function load() {
  if (!existsSync(USERS_FILE)) return []
  try { return JSON.parse(readFileSync(USERS_FILE, 'utf-8')) } catch { return [] }
}

function save(users) {
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

// ── Ensure default admin exists ───────────────────────────────────────────────

function ensureDefaults() {
  const users = load()
  if (users.length === 0) {
    users.push({
      id:                 '1',
      username:           'admin',
      passwordHash:       hashPassword('admin'),
      role:               'admin',
      mustChangePassword: true,
      createdAt:          new Date().toISOString(),
    })
    save(users)
    console.log('  [auth] Usuario admin creado con contraseña por defecto — cámbiala al entrar')
  }
}

ensureDefaults()

// ── Public API ────────────────────────────────────────────────────────────────

export function findByUsername(username) {
  return load().find(u => u.username === username) || null
}

export function findById(id) {
  return load().find(u => u.id === id) || null
}

export function listUsers() {
  return load().map(({ passwordHash, ...u }) => u)  // never expose hash
}

export function authenticate(username, password) {
  const user = findByUsername(username)
  if (!user) return null
  if (!verifyPassword(password, user.passwordHash)) return null
  const { passwordHash, ...safe } = user
  return safe
}

export function createUser(username, password, role = 'user') {
  const users = load()
  if (users.find(u => u.username === username)) {
    throw new Error(`El usuario "${username}" ya existe`)
  }
  const id = String(Date.now())
  const user = {
    id,
    username,
    passwordHash:       hashPassword(password),
    role,
    mustChangePassword: false,
    createdAt:          new Date().toISOString(),
  }
  users.push(user)
  save(users)
  const { passwordHash, ...safe } = user
  return safe
}

export function updateUser(id, { password, role, mustChangePassword }) {
  const users = load()
  const idx   = users.findIndex(u => u.id === id)
  if (idx === -1) throw new Error('Usuario no encontrado')

  if (password !== undefined)           users[idx].passwordHash       = hashPassword(password)
  if (role !== undefined)               users[idx].role               = role
  if (mustChangePassword !== undefined) users[idx].mustChangePassword = mustChangePassword

  save(users)
  const { passwordHash, ...safe } = users[idx]
  return safe
}

export function deleteUser(id) {
  const users = load()
  const idx   = users.findIndex(u => u.id === id)
  if (idx === -1) throw new Error('Usuario no encontrado')
  if (users[idx].role === 'admin' && users.filter(u => u.role === 'admin').length === 1) {
    throw new Error('No puedes eliminar el último administrador')
  }
  users.splice(idx, 1)
  save(users)
}
