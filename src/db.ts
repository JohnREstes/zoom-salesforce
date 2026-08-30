import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
}

export const db = new Pool({
    connectionString: process.env.DATABASE_URL
});