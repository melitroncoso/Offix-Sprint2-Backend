import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const db = new PrismaClient();
const app = express();
app.use(cors()); app.use(express.json({limit:'1mb'}));
const secret=process.env.JWT_SECRET;
if(!secret || secret.length<24) throw new Error('Definí JWT_SECRET de al menos 24 caracteres en .env');
const wrap=(fn:any)=>(req:any,res:any,next:any)=>Promise.resolve(fn(req,res,next)).catch(next);
const auth=wrap(async(req:any,res:any,next:any)=>{
 const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
 try { const payload=jwt.verify(token,secret) as {id:string}; const user=await db.user.findUnique({where:{id:payload.id}}); if(!user || !user.isActive)return res.status(401).json({error:'Sesión inválida'}); req.user=user;next(); }
 catch{return res.status(401).json({error:'No autorizado'});}
});
const publicUser=(u:any)=>({id:u.id,username:u.username,name:u.name,role:u.role,profession:u.profession,description:u.description,services:u.services,schedule:u.schedule});
const requestInclude={
  client:{select:{id:true,name:true}},
  quotes:{include:{provider:{select:{id:true,name:true,profession:true}}}},
  delays:true,
  evidence:true,
  payment:true,
  review:true
} as const;const canView=(r:any,u:any)=>r.clientId===u.id || r.quotes.some((q:any)=>q.providerId===u.id);
const load=(id:string)=>db.request.findUnique({where:{id},include:requestInclude});
app.get('/health',(_req,res)=>res.json({ok:true}));
app.post('/auth/register', wrap(async (req: any, res: any) => {
  const data = z.object({
    username: z.string().min(3),
    password: z.string().min(8),
    name: z.string().min(2),
    role: z.enum(['CLIENTE', 'PROVEEDOR']),
    dni: z.string().optional(),
    profession: z.string().optional(),
    description: z.string().optional(),
    services: z.string().optional(),
  }).parse(req.body);

  if (data.role === 'PROVEEDOR' && !data.profession) {
    return res.status(400).json({ error: 'Falta profesión' });
  }

  const user = await db.user.create({
    data: {
      username: data.username.trim(),
      name: data.name,
      role: data.role,
      dni: data.dni,
      profession: data.role === 'PROVEEDOR' ? data.profession : undefined,
      description: data.role === 'PROVEEDOR' ? data.description : undefined,
      services: data.role === 'PROVEEDOR' ? data.services : undefined,
      passwordHash: await bcrypt.hash(data.password, 12),
    },
  });

  res.status(201).json({
    user: publicUser(user),
    token: jwt.sign({ id: user.id }, secret, { expiresIn: '7d' }),
  });
}));
app.post('/auth/login',wrap(async(req:any,res:any)=>{
 const {username,password}=z.object({username:z.string(),password:z.string()}).parse(req.body);
 const user=await db.user.findUnique({where:{username}});
if(!user || !user.isActive || !(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({error:'Credenciales incorrectas'}); res.json({user:publicUser(user),token:jwt.sign({id:user.id},secret,{expiresIn:'7d'})});
}));
app.get('/me',auth,(req:any,res)=>res.json(publicUser(req.user)));
app.delete('/me',auth,wrap(async(req:any,res:any)=>{
  const id=req.user.id;

  await db.user.update({
    where:{id},
    data:{
      isActive:false,
      deletedAt:new Date(),
      username:`deleted_${id}`,
      dni:null,
      passwordHash:await bcrypt.hash(randomUUID(),12)
    }
  });

  res.json({message:'Cuenta eliminada correctamente'});
}));
app.patch('/me',auth,wrap(async(req:any,res:any)=>{const data=z.object({name:z.string().min(2).optional(),profession:z.string().optional(),description:z.string().optional(),services:z.string().optional(),schedule:z.string().optional()}).strict().parse(req.body);res.json(publicUser(await db.user.update({where:{id:req.user.id},data})));}));
app.get('/providers', auth, wrap(async (req: any, res: any) => {
  const profession = typeof req.query.profession === 'string' ? req.query.profession : undefined;
  const users = await db.user.findMany({
    where: { role: 'PROVEEDOR', isActive: true, ...(profession ? { profession } : {}) },
    select: { id: true, name: true, profession: true, description: true, services: true, schedule: true }
  });

  if (users.length === 0) return res.json([]);
  const ids = users.map(user => user.id);

  const [reviewStats, finishedRequests] = await Promise.all([
    db.review.groupBy({
      by: ['providerId'],
      where: { providerId: { in: ids } },
      _avg: { rating: true },
      _count: { _all: true }
    }),
    db.request.findMany({
      where: {
        status: 'FINALIZADO',
        selectedQuoteId: { not: null },
        quotes: { some: { providerId: { in: ids }, status: 'SELECCIONADO' } }
      },
      select: {
        selectedQuoteId: true,
        quotes: { select: { id: true, providerId: true } }
      }
    })
  ]);

  const ratings = new Map(reviewStats.map(stat => [stat.providerId, {
    rating: stat._avg.rating,
    reviewCount: stat._count._all
  }]));
  const jobs = new Map<string, number>();
  for (const request of finishedRequests) {
    // Solo cuenta el presupuesto efectivamente seleccionado para este trabajo.
    const selected = request.quotes.find(quote => quote.id === request.selectedQuoteId);
    if (selected && ids.includes(selected.providerId)) {
      jobs.set(selected.providerId, (jobs.get(selected.providerId) ?? 0) + 1);
    }
  }

  res.json(users.map(user => ({
    ...user,
    rating: ratings.get(user.id)?.rating ?? null,
    reviewCount: ratings.get(user.id)?.reviewCount ?? 0,
    trabajos: jobs.get(user.id) ?? 0
  })));
}));
app.post('/requests', auth, wrap(async (req: any, res: any) => {
  if (req.user.role !== 'CLIENTE') {
    return res.status(403).json({ error: 'Solo clientes' });
  }

  const d = z.object({
  profession: z.string().min(1),
  description: z.string().min(5),
  preferredDate: z.string().min(1),

  providers: z.array(z.object({
    providerId: z.string(),
    moment: z.enum(['Mañana', 'Tarde', 'Noche'])
  })).min(1).max(30)
}).parse(req.body);
const ids = d.providers.map(p => p.providerId);

  const idsUnicos = [...new Set(ids)];

  if (idsUnicos.length !== ids.length) {
    return res.status(400).json({
      error: 'Hay proveedores repetidos'
    });
  }

  const providers = await db.user.findMany({
    where: {
      id: { in: idsUnicos },
      role: 'PROVEEDOR',
      isActive: true
    }
  });

  if (
    providers.length !== idsUnicos.length ||
    providers.some(p => p.profession !== d.profession)
  ) {
    return res.status(400).json({
      error: 'Proveedores inválidos o de otra profesión'
    });
  }


    const partes = d.preferredDate.split('-').map(Number);

    if (
      partes.length !== 3 ||
      partes.some(n => !Number.isInteger(n))
    ) {
      return res.status(400).json({
        error: 'Fecha inválida'
      });
    }

    const [anio, mes, dia] = partes;
    const fecha = new Date(anio, mes - 1, dia);

    if (
      fecha.getFullYear() !== anio ||
      fecha.getMonth() !== mes - 1 ||
      fecha.getDate() !== dia
    ) {
      return res.status(400).json({
        error: 'Fecha inválida'
      });
    }

    const nombresDias = [
      'Domingo', 'Lunes', 'Martes', 'Miércoles',
      'Jueves', 'Viernes', 'Sábado'
    ];

    const nombreDia = nombresDias[fecha.getDay()];

for (const elegido of d.providers) {      const proveedor = providers.find(
        p => p.id === elegido.providerId
      );

      let disponibilidad: unknown;

      try {
        disponibilidad = JSON.parse(proveedor?.schedule || 'null');
      } catch {
        return res.status(400).json({
          error: 'Disponibilidad inválida del proveedor'
        });
      }

      if (!Array.isArray(disponibilidad)) {
        return res.status(400).json({
          error: 'El proveedor no tiene disponibilidad configurada'
        });
      }

      const configuracion = disponibilidad.find(
        (item: any) =>
          item &&
          item.nombre === nombreDia
      );

      if (
        !configuracion ||
        configuracion.activo !== true ||
        !Array.isArray(configuracion.momentos) ||
        !configuracion.momentos.includes(elegido.moment)
      ) {
        return res.status(400).json({
          error: `El proveedor ${proveedor?.name} no está disponible el ${nombreDia} por la ${elegido.moment.toLowerCase()}`
        });
      }
    }
  

  const created = await db.request.create({
    data: {
clientId: req.user.id,      profession: d.profession,
      description: d.description,
      preferredDate: d.preferredDate,
      quotes: {
  create: d.providers.map(p => ({
    providerId: p.providerId,
    preferredMoment: p.moment
  }))
}
    },
    include: requestInclude
  });

  res.status(201).json(created);
}));

app.get('/requests', auth, wrap(async (req: any, res: any) => {
  const usuarioId = req.user.id;

  const filtro =
    req.user.role === 'CLIENTE'
      ? {
          clientId: usuarioId
        }
      : {
          quotes: {
            some: {
              providerId: usuarioId,
              status: {
                in: ['PENDIENTE', 'PRESUPUESTADO', 'SELECCIONADO']
              }
            }
          }
        };

  const trabajos = await db.request.findMany({
    where: filtro,
    include: requestInclude,
    orderBy: {
      createdAt: 'desc'
    }
  });

  res.json(trabajos);
}));
app.get('/requests/:id',auth,wrap(async(req:any,res:any)=>{const r=await load(req.params.id);if(!r)return res.status(404).json({error:'No encontrado'});if(!canView(r,req.user))return res.status(403).json({error:'Sin acceso'});res.json(r);}));
app.patch('/quotes/:id', auth, wrap(async (req: any, res: any) => {
  const d = z.object({
    status: z.enum(['PRESUPUESTADO', 'RECHAZADO']),
    amount: z.number().int().positive().optional(),
    detail: z.string().optional()
  }).parse(req.body);

  const q = await db.quote.findUnique({
    where: { id: req.params.id },
    include: { request: true }
  });

  if (!q || q.providerId !== req.user.id) {
    return res.status(403).json({ error: 'Sin acceso' });
  }

  if (
    q.status !== 'PENDIENTE' ||
    q.request.selectedQuoteId ||
    !['SOLICITADO', 'PRESUPUESTADO'].includes(q.request.status)
  ) {
    return res.status(409).json({ error: 'Cotización cerrada' });
  }

  if (d.status === 'PRESUPUESTADO' && !d.amount) {
    return res.status(400).json({ error: 'Falta importe' });
  }

  const resultado = await db.$transaction(async (tx) => {
    // Actualizamos el presupuesto de este proveedor.
    const cotizacion = await tx.quote.update({
      where: { id: q.id },
      data: {
        status: d.status,
        amount: d.status === 'PRESUPUESTADO' ? d.amount : null,
        detail: d.detail
      }
    });

    // El primer presupuesto recibido cambia el estado general.
    if (
      d.status === 'PRESUPUESTADO' &&
      q.request.status === 'SOLICITADO'
    ) {
      await tx.request.update({
        where: { id: q.requestId },
        data: { status: 'PRESUPUESTADO' }
      });
    }

    return cotizacion;
  });

  res.json(resultado);
}));
app.post('/requests/:id/select',auth,wrap(async(req:any,res:any)=>{
 const {quoteId}=z.object({quoteId:z.string()}).parse(req.body);const r=await load(req.params.id);
 if(!r||r.clientId!==req.user.id)return res.status(403).json({error:'Sin acceso'});
 if(r.selectedQuoteId)return res.status(409).json({error:'Ya se eligió proveedor'});
 const q=r.quotes.find(x=>x.id===quoteId&&x.status==='PRESUPUESTADO');if(!q)return res.status(400).json({error:'Presupuesto inválido'});
 await db.$transaction([db.request.update({where:{id:r.id},data:{selectedQuoteId:quoteId,status:'EN_CURSO'}}),db.quote.updateMany({where:{requestId:r.id,id:{not:quoteId}},data:{status:'CERRADO'}}),db.quote.update({where:{id:quoteId},data:{status:'SELECCIONADO'}})]);
 res.json(await load(r.id));
}));
app.post('/requests/:id/delays',auth,wrap(async(req:any,res:any)=>{
 const d=z.object({reason:z.string().min(3),minutes:z.number().int().min(1).max(1440)}).parse(req.body);const r=await load(req.params.id);
 if(!r||!r.selectedQuoteId||r.quotes.find(x=>x.id===r.selectedQuoteId)?.providerId!==req.user.id)return res.status(403).json({error:'Solo proveedor elegido'});
 if(r.status!=='EN_CURSO')return res.status(409).json({error:'Trabajo no está en curso'});
 res.status(201).json(await db.delay.create({data:{requestId:r.id,providerId:req.user.id,reason:d.reason,minutes:d.minutes}}));
}));
app.post('/requests/:id/complete',auth,wrap(async(req:any,res:any)=>{
 const r=await load(req.params.id);if(!r||r.quotes.find(x=>x.id===r.selectedQuoteId)?.providerId!==req.user.id)return res.status(403).json({error:'Sin acceso'});
 if(r.status!=='EN_CURSO')return res.status(409).json({error:'Estado inválido'});
 const d=z.object({materials:z.number().int().min(0),labor:z.number().int().min(0)}).parse(req.body);
 await db.$transaction([db.payment.create({data:{requestId:r.id,materials:d.materials,labor:d.labor}}),db.request.update({where:{id:r.id},data:{status:'A_PAGAR'}})]);res.json(await load(r.id));
}));
app.post('/requests/:id/mark-paid',auth,wrap(async(req:any,res:any)=>{
 const r=await load(req.params.id);if(!r||r.clientId!==req.user.id)return res.status(403).json({error:'Sin acceso'});
 if(r.status!=='A_PAGAR'||!r.payment)return res.status(409).json({error:'No hay cobro pendiente'});
 await db.$transaction([db.payment.update({where:{requestId:r.id},data:{status:'DECLARADO_PAGADO'}}),db.request.update({where:{id:r.id},data:{status:'FINALIZADO'}})]);res.json(await load(r.id));
}));
app.post('/requests/:id/reviews', auth, wrap(async (req:any, res:any) => {
  const data = z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().min(1)
  }).parse(req.body);

  const r = await load(req.params.id);

  if (!r || r.clientId !== req.user.id) {
    return res.status(403).json({error:'Sin acceso'});
  }

  if (r.status !== 'FINALIZADO') {
    return res.status(409).json({error:'El trabajo debe estar finalizado'});
  }

  if (!r.selectedQuoteId) {
    return res.status(409).json({error:'No hay proveedor seleccionado'});
  }

  const selected = r.quotes.find(q => q.id === r.selectedQuoteId);

  if (!selected) {
    return res.status(409).json({error:'Proveedor no encontrado'});
  }

  if (r.review) {
    return res.status(409).json({error:'Este trabajo ya tiene una reseña'});
  }

  const review = await db.review.create({
    data: {
      requestId: r.id,
      clientId: req.user.id,
      providerId: selected.providerId,
      rating: data.rating,
      comment: data.comment
    }
  });

  res.status(201).json(review);
}));

 // Obtener las reseñas públicas de un proveedor.
app.get('/providers/:id/reviews', auth, wrap(async (req: any, res: any) => {
  const proveedor = await db.user.findFirst({
    where: {
      id: req.params.id,
      role: 'PROVEEDOR',
      isActive: true
    },
    select: { id: true }
  });

  if (!proveedor) {
    return res.status(404).json({
      error: 'Proveedor no encontrado'
    });
  }

  const resenas = await db.review.findMany({
    where: {
      providerId: proveedor.id
    },
    include: {
      client: {
        select: {
          name: true
        }
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  const resultado = resenas.map(resena => ({
    id: resena.id,
    rating: resena.rating,
    comment: resena.comment,
    createdAt: resena.createdAt,
    clientName: resena.client.name
  }));

  res.json(resultado);
}));

const ESTADOS_CHAT_ACTIVO = ['EN_CURSO', 'A_PAGAR'];

const obtenerContextoChat = async (requestId: string, userId: string) => {
  const trabajo = await db.request.findUnique({
    where: { id: requestId },
    include: {
      quotes: true,
    },
  });

  if (!trabajo || !trabajo.selectedQuoteId) {
    return null;
  }

  const presupuestoElegido = trabajo.quotes.find(
    (q) => q.id === trabajo.selectedQuoteId
  );

  if (!presupuestoElegido) {
    return null;
  }

  const clientId = trabajo.clientId;
  const providerId = presupuestoElegido.providerId;

  // Solo el cliente y el proveedor seleccionado pueden acceder.
  if (userId !== clientId && userId !== providerId) {
    return null;
  }

  // Una solicitud pendiente o presupuestada nunca abre el chat.
  if (!['EN_CURSO', 'A_PAGAR', 'FINALIZADO'].includes(trabajo.status)) {
    return null;
  }

  const trabajosRelacionados = await db.request.findMany({
    where: {
      clientId,
      selectedQuoteId: { not: null },
      quotes: {
        some: {
          providerId,
          status: 'SELECCIONADO',
        },
      },
      status: {
        in: ['EN_CURSO', 'A_PAGAR', 'FINALIZADO'],
      },
    },
    include: {
      quotes: true,
    },
  });

  // Verificamos que el proveedor sea realmente el seleccionado.
  const trabajosValidos = trabajosRelacionados.filter((r) =>
    r.quotes.some(
      (q) =>
        q.id === r.selectedQuoteId &&
        q.providerId === providerId
    )
  );

  const puedeEscribir = trabajosValidos.some((r) =>
    ESTADOS_CHAT_ACTIVO.includes(r.status)
  );

  return {
    clientId,
    providerId,
    trabajosValidos,
    puedeEscribir,
  };
};

// Obtener mensajes compartidos.
app.get(
  '/requests/:id/messages',
  auth,
  wrap(async (req: any, res: any) => {
    const contexto = await obtenerContextoChat(
      req.params.id,
      req.user.id
    );

    if (!contexto) {
      return res.status(403).json({
        error: 'El chat no está disponible para esta solicitud',
      });
    }

    const { clientId, providerId, trabajosValidos } = contexto;

    const conversation = await db.conversation.upsert({
      where: {
        clientId_providerId: { clientId, providerId },
      },
      update: {},
      create: { clientId, providerId },
    });

    const idsTrabajos = trabajosValidos.map((r) => r.id);

    // Incorporamos los mensajes antiguos de los trabajos anteriores.
    await db.message.updateMany({
      where: {
        requestId: { in: idsTrabajos },
        conversationId: null,
      },
      data: {
        conversationId: conversation.id,
      },
    });

    const mensajes = await db.message.findMany({
      where: {
        conversationId: conversation.id,
      },
      orderBy: [
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });

    res.json(mensajes);
  })
);

// Enviar mensaje al chat compartido.
app.post(
  '/requests/:id/messages',
  auth,
  wrap(async (req: any, res: any) => {
    const contexto = await obtenerContextoChat(
      req.params.id,
      req.user.id
    );

    if (!contexto) {
      return res.status(403).json({
        error: 'El chat no está disponible para esta solicitud',
      });
    }

    if (!contexto.puedeEscribir) {
      return res.status(409).json({
        error: 'El chat está cerrado porque todos los trabajos finalizaron',
      });
    }

    const { body } = z.object({
      body: z.string().trim().min(1).max(2000),
    }).parse(req.body);

    const { clientId, providerId, trabajosValidos } = contexto;

    const conversation = await db.conversation.upsert({
      where: {
        clientId_providerId: { clientId, providerId },
      },
      update: {},
      create: { clientId, providerId },
    });

    // Si se está consultando un trabajo finalizado, guardamos el
    // mensaje bajo un trabajo activo de la misma pareja.
    const trabajoActivo = trabajosValidos.find((r) =>
      ESTADOS_CHAT_ACTIVO.includes(r.status)
    );

    if (!trabajoActivo) {
      return res.status(409).json({
        error: 'No hay trabajos activos para este chat',
      });
    }

    const mensaje = await db.message.create({
      data: {
        requestId: trabajoActivo.id,
        conversationId: conversation.id,
        authorId: req.user.id,
        body,
      },
    });

    res.status(201).json(mensaje);
  })
);

app.get(
  '/requests/:id/chat-status',
  auth,
  wrap(async (req: any, res: any) => {
    const contexto = await obtenerContextoChat(
      req.params.id,
      req.user.id
    );

    if (!contexto) {
      return res.json({
        disponible: false,
        puedeEscribir: false,
      });
    }

    return res.json({
      disponible: true,
      puedeEscribir: contexto.puedeEscribir,
    });
  })
);

const obtenerEstadoConversacion = async (
  clientId: string,
  providerId: string
) => {
  const trabajos = await db.request.findMany({
    where: {
      clientId,
      selectedQuoteId: { not: null },
      status: { in: ['EN_CURSO', 'A_PAGAR', 'FINALIZADO'] },
      quotes: {
        some: { providerId },
      },
    },
    include: {
      quotes: true,
    },
  });

  const trabajosValidos = trabajos.filter((trabajo) =>
    trabajo.quotes.some(
      (quote) =>
        quote.id === trabajo.selectedQuoteId &&
        quote.providerId === providerId
    )
  );

  return {
    trabajosValidos,
    puedeEscribir: trabajosValidos.some(
      (trabajo) =>
        trabajo.status === 'EN_CURSO' ||
        trabajo.status === 'A_PAGAR'
    ),
  };
};

app.get('/requests/:id/conversation', auth, wrap(async (req: any, res: any) => {
  const contexto = await obtenerContextoChat(
    req.params.id,
    req.user.id
  );

  if (!contexto || contexto.trabajosValidos.length === 0) {
    return res.status(403).json({
      error: 'El chat no está disponible para este trabajo',
    });
  }

  const { clientId, providerId, trabajosValidos } = contexto;

  const conversacion = await db.conversation.upsert({
    where: {
      clientId_providerId: { clientId, providerId },
    },
    update: {},
    create: { clientId, providerId },
  });

  await db.message.updateMany({
    where: {
      requestId: {
        in: trabajosValidos.map(trabajo => trabajo.id),
      },
      conversationId: null,
    },
    data: {
      conversationId: conversacion.id,
    },
  });

  res.json({ id: conversacion.id });
}));

// Una conversación por cliente y proveedor.
app.get('/conversations', auth, wrap(async (req: any, res: any) => {
  const usuarioId = req.user.id;

  const trabajos = await db.request.findMany({
    where:
      req.user.role === 'CLIENTE'
        ? { clientId: usuarioId, selectedQuoteId: { not: null } }
        : {
            selectedQuoteId: { not: null },
            quotes: { some: { providerId: usuarioId } },
          },
    include: {
      quotes: true,
      client: { select: { id: true, name: true } },
    },
  });

  const parejas = new Map<string, {
    clientId: string;
    providerId: string;
    nombre: string;
    profesion: string;
  }>();

  for (const trabajo of trabajos) {
    const elegido = trabajo.quotes.find(
      (q) => q.id === trabajo.selectedQuoteId
    );

    if (!elegido) continue;

    if (
      req.user.role === 'PROVEEDOR' &&
      elegido.providerId !== usuarioId
    ) continue;

    const proveedor = await db.user.findUnique({
      where: { id: elegido.providerId },
      select: { name: true, profession: true },
    });

    const clave = `${trabajo.clientId}:${elegido.providerId}`;

    parejas.set(clave, {
      clientId: trabajo.clientId,
      providerId: elegido.providerId,
      nombre:
        req.user.role === 'CLIENTE'
          ? proveedor?.name || 'Proveedor'
          : trabajo.client.name,
      profesion: proveedor?.profession || trabajo.profession,
    });
  }

  const resultado = [];

  for (const pareja of parejas.values()) {
    const estado = await obtenerEstadoConversacion(
      pareja.clientId,
      pareja.providerId
    );

    if (estado.trabajosValidos.length === 0) continue;

    const conversation = await db.conversation.upsert({
      where: {
        clientId_providerId: {
          clientId: pareja.clientId,
          providerId: pareja.providerId,
        },
      },
      update: {},
      create: {
        clientId: pareja.clientId,
        providerId: pareja.providerId,
      },
    });

    const idsTrabajos = estado.trabajosValidos.map((t) => t.id);

    // Conservamos y vinculamos los mensajes de trabajos anteriores.
    await db.message.updateMany({
      where: {
        requestId: { in: idsTrabajos },
        conversationId: null,
      },
      data: { conversationId: conversation.id },
    });

    const ultimo = await db.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
    });

    resultado.push({
      id: conversation.id,
      nombre: pareja.nombre,
      detalle: pareja.profesion,
      ultimoMensaje: ultimo?.body || 'Todavía no hay mensajes',
      hora: ultimo?.createdAt || null,
      puedeEscribir: estado.puedeEscribir,
    });
  }

  res.json(resultado);
}));

// Obtener una conversación compartida.
app.get('/conversations/:id', auth, wrap(async (req: any, res: any) => {
  const conversation = await db.conversation.findUnique({
    where: { id: req.params.id },
    include: {
      client: { select: { name: true } },
      provider: { select: { name: true, profession: true } },
    },
  });

  if (!conversation) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }

  if (
    req.user.id !== conversation.clientId &&
    req.user.id !== conversation.providerId
  ) {
    return res.status(403).json({ error: 'Sin acceso' });
  }

  const estado = await obtenerEstadoConversacion(
    conversation.clientId,
    conversation.providerId
  );

  const mensajes = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  res.json({
    id: conversation.id,
    nombre:
      req.user.id === conversation.clientId
        ? conversation.provider.name
        : conversation.client.name,
    oficio: conversation.provider.profession || '',
    puedeEscribir: estado.puedeEscribir,
    mensajes,
  });
}));

// Enviar un mensaje a la conversación compartida.
app.post('/conversations/:id/messages', auth, wrap(async (req: any, res: any) => {
  const conversation = await db.conversation.findUnique({
    where: { id: req.params.id },
  });

  if (!conversation) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }

  if (
    req.user.id !== conversation.clientId &&
    req.user.id !== conversation.providerId
  ) {
    return res.status(403).json({ error: 'Sin acceso' });
  }

  const estado = await obtenerEstadoConversacion(
    conversation.clientId,
    conversation.providerId
  );

  if (!estado.puedeEscribir) {
    return res.status(409).json({
      error: 'El chat está en modo solo lectura',
    });
  }

  const { body } = z.object({
    body: z.string().trim().min(1).max(2000),
  }).parse(req.body);

  const trabajoActivo = estado.trabajosValidos.find(
    (t) => t.status === 'EN_CURSO' || t.status === 'A_PAGAR'
  );

  if (!trabajoActivo) {
    return res.status(409).json({ error: 'No hay trabajos activos' });
  }

  const mensaje = await db.message.create({
    data: {
      conversationId: conversation.id,
      requestId: trabajoActivo.id,
      authorId: req.user.id,
      body,
    },
  });

  res.status(201).json(mensaje);
}));

const uploads=path.resolve('uploads');mkdirSync(uploads,{recursive:true});
const upload=multer({storage:multer.diskStorage({destination:uploads,filename:(_req,file,cb)=>cb(null,randomUUID()+path.extname(file.originalname).toLowerCase())}),limits:{fileSize:5*1024*1024},fileFilter:(_req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))});
app.post('/requests/:id/evidence',auth,upload.single('photo'),wrap(async(req:any,res:any)=>{
 const r=await load(req.params.id);if(!r||!canView(r,req.user))return res.status(403).json({error:'Sin acceso'});
 const {stage}=z.object({stage:z.enum(['ANTES','DESPUES'])}).parse(req.body);
 if(!req.file)return res.status(400).json({error:'Adjuntá una imagen JPG, PNG o WebP'});
 res.status(201).json(await db.evidence.create({data:{requestId:r.id,authorId:req.user.id,stage,filename:req.file.filename}}));
}));
app.get('/evidence/:id',auth,wrap(async(req:any,res:any)=>{const e=await db.evidence.findUnique({where:{id:req.params.id}});if(!e)return res.status(404).end();const r=await load(e.requestId);if(!r||!canView(r,req.user))return res.status(403).end();res.sendFile(path.join(uploads,e.filename));}));
app.get('/evidence/:id/image-data', auth, wrap(async (req: any, res: any) => {
  const foto = await db.evidence.findUnique({
    where: { id: req.params.id }
  });

  if (!foto) {
    return res.status(404).json({ error: 'Foto no encontrada' });
  }

  const solicitud = await load(foto.requestId);

  if (!solicitud || !canView(solicitud, req.user)) {
    return res.status(403).json({ error: 'Sin acceso' });
  }

  const extension = path.extname(foto.filename).toLowerCase();

  const mime =
    extension === '.png' ? 'image/png' :
    extension === '.webp' ? 'image/webp' :
    'image/jpeg';

  const archivo = await readFile(path.join(uploads, foto.filename));

  res.json({
    id: foto.id,
    uri: `data:${mime};base64,${archivo.toString('base64')}`
  });
}));
app.use((err:any,_req:any,res:any,_next:any)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'Datos inválidos',details:err.flatten()});if(err.code==='P2002')return res.status(409).json({error:'Registro duplicado'});if(err instanceof multer.MulterError)return res.status(400).json({error:err.message});console.error(err);res.status(500).json({error:'Error interno'});});
const port=Number(process.env.PORT||3000);app.listen(port,'0.0.0.0',()=>console.log(`Offix API en http://localhost:${port}`));
