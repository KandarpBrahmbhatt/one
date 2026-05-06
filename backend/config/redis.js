import "dotenv/config";
import Redis from "ioredis";

const redisEnabled = process.env.REDIS_ENABLED === "true";
let client = null;
let isRedisReady = false;

if (redisEnabled) {
    client = new Redis({
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: Number(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy(times) {
            return times > 3 ? null : Math.min(times * 200, 1000);
        }
    });

    client.on("ready", () => {
        isRedisReady = true;
        console.log("Redis connected");
    });

    client.on("end", () => {
        isRedisReady = false;
    });

    client.on("error", (err) => {
        isRedisReady = false;
        console.log("Redis Error:", err.message);
    });
} else {
    console.log("Redis disabled. Set REDIS_ENABLED=true in .env to use cache.");
}

const redis = {
    isEnabled() {
        return redisEnabled;
    },

    isReady() {
        return isRedisReady;
    },

    async get(key) {
        if (!redisEnabled || !isRedisReady) return null;

        try {
            return await client.get(key);
        } catch (err) {
            console.log("Redis GET Error:", err.message);
            return null;
        }
    },

    async set(key, value, ...args) {
        if (!redisEnabled || !isRedisReady) return null;

        try {
            return await client.set(key, value, ...args);
        } catch (err) {
            console.log("Redis SET Error:", err.message);
            return null;
        }
    }
};

export default redis;
