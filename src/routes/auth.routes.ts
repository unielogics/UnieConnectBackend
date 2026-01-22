import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { User } from '../models/user';
import { config } from '../config/env';
import crypto from 'crypto';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/login', async (req: any, reply) => {
    const { email, password } = req.body || {};
    const normalizedEmail = email ? String(email).toLowerCase() : '';
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'login-timeout-pre',hypothesisId:'H1',location:'src/routes/auth.routes.ts:13',message:'backend login handler entry',data:{hasEmail:Boolean(email),hasPassword:Boolean(password)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    req.log.info({ reqId: req.id, email: normalizedEmail, ip: req.ip }, 'login attempt');
    if (!email || !password) return reply.code(400).send({ error: 'Email and password required' });
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) {
      req.log.warn({ reqId: req.id, email: normalizedEmail }, 'login failed: user not found');
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'login-timeout-pre',hypothesisId:'H2',location:'src/routes/auth.routes.ts:20',message:'backend login user not found',data:{hasUser:false},timestamp:Date.now()})}).catch(()=>{});
      // #endregion agent log
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      req.log.warn({ reqId: req.id, email: normalizedEmail, userId: user._id }, 'login failed: bad password');
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'login-timeout-pre',hypothesisId:'H3',location:'src/routes/auth.routes.ts:27',message:'backend login bad password',data:{hasUser:true,passwordOk:false},timestamp:Date.now()})}).catch(()=>{});
      // #endregion agent log
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user._id, email: user.email }, config.authSecret, { expiresIn: '7d' });
    req.log.info({ reqId: req.id, userId: user._id, email: user.email }, 'login success');
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'login-timeout-pre',hypothesisId:'H4',location:'src/routes/auth.routes.ts:33',message:'backend login success',data:{tokenIssued:Boolean(token)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    return { token };
  });

  fastify.post('/auth/change-password', async (req: any, reply) => {
    const userId = req.user?.userId;
    req.log.info({ reqId: req.id, userId }, 'change password attempt');
    const { oldPassword, newPassword } = req.body || {};
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: 'oldPassword and newPassword required' });
    const user = await User.findById(userId).exec();
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: 'Invalid credentials' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetToken = null as any;
    user.resetTokenExpires = null as any;
    await user.save();
    req.log.info({ reqId: req.id, userId }, 'password updated');
    return { success: true };
  });

  fastify.post('/auth/request-reset', async (req: any, reply) => {
    const { email } = req.body || {};
    const normalizedEmail = email ? String(email).toLowerCase() : '';
    req.log.info({ reqId: req.id, email: normalizedEmail }, 'password reset requested');
    if (!email) return reply.code(400).send({ error: 'Email required' });
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) return reply.send({ success: true }); // avoid leakage
    const token = crypto.randomBytes(24).toString('hex');
    user.resetToken = token as any;
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    req.log.info({ reqId: req.id, userId: user._id, email: user.email }, 'password reset token issued');
    // Since email not set up, return token in response for now
    return { success: true, resetToken: token };
  });

  fastify.post('/auth/reset-password', async (req: any, reply) => {
    const { token, newPassword } = req.body || {};
    req.log.info({ reqId: req.id, hasToken: Boolean(token) }, 'reset password attempt');
    if (!token || !newPassword) return reply.code(400).send({ error: 'token and newPassword required' });
    const user = await User.findOne({ resetToken: token }).exec();
    if (!user || !user.resetTokenExpires || user.resetTokenExpires.getTime() < Date.now()) {
      req.log.warn({ reqId: req.id }, 'reset password failed: invalid/expired token');
      return reply.code(400).send({ error: 'Invalid or expired token' });
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetToken = null as any;
    user.resetTokenExpires = null as any;
    await user.save();
    req.log.info({ reqId: req.id, userId: user._id }, 'password reset success');
    return { success: true };
  });
}

