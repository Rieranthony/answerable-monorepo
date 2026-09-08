import { eq, and } from '../apps/id/node_modules/drizzle-orm/index.js'
import { createDatabase } from '../apps/id/src/db/client.ts'
import { testEnvironment } from '../apps/id/src/__tests__/support.ts'
import { assertDisposableTestDatabase } from '../apps/id/src/__tests__/test-database.ts'
import { createId } from '../apps/id/src/lib/id.ts'
import * as schema from '../apps/id/src/db/schema/index.ts'
import * as audits from '../apps/id/src/services/audit.ts'
import * as membersService from '../apps/id/src/services/members.ts'
import * as usersService from '../apps/id/src/services/users.ts'
import * as clients from '../apps/id/src/services/clients.ts'
import { createAuth } from '../apps/id/src/auth.ts'
import { createApp } from '../apps/id/src/app.ts'
assertDisposableTestDatabase('run feedback probes')
const environment = testEnvironment()
const connection = createDatabase(environment)
const db = connection.db
const actor = { actorType: 'system' as const, actorId: `review-${createId()}`, requestId: createId() }
const org1 = createId(), org2 = createId(), userId = createId(), memberId = createId(), resourceId = createId()
const clientId = `review-${createId()}`
const resource = environment.adminResourceIdentifier
const results: Record<string, unknown> = {}
try {
 await db.insert(schema.organizations).values([{id:org1,slug:`review-${org1}`,name:'Review one'},{id:org2,slug:`review-${org2}`,name:'Review two'}])
 await db.insert(schema.users).values({id:userId,name:'Review fixture',email:`${userId}@example.com`,status:'active'})
 await db.insert(schema.members).values({id:memberId,userId,organizationId:org1,role:'member'})
 await membersService.updateWindow(db,actor,org1,memberId,{validUntil:new Date('2100-01-01')})
 const before = await audits.listUserAuditEvents(db,userId,{}, {limit:100})
 await membersService.remove(db,actor,org1,memberId)
 const after = await audits.listUserAuditEvents(db,userId,{}, {limit:100})
 const stored = await audits.listAuditEvents(db,{targetType:'member',targetId:memberId},{limit:100})
 results.membershipHistory = {before:before.items.map(x=>x.action),after:after.items.map(x=>x.action),stored:stored.items.map(x=>({action:x.action,data:x.data}))}
 await usersService.eraseUser(db,actor,userId,userId)
 try {await audits.listUserAuditEvents(db,userId,{}, {limit:100});results.erasedUserLookup='unexpected success'} catch(e:any) {results.erasedUserLookup={status:e.status,code:e.code}}
 results.erasureEvent = (await audits.listAuditEvents(db,{targetType:'user',targetId:userId},{limit:100})).items.map(x=>({targetId:x.targetId,data:x.data}))
 const [existingResource] = await db.select().from(schema.oauthResources).where(eq(schema.oauthResources.identifier,resource))
 if(!existingResource) await db.insert(schema.oauthResources).values({id:resourceId,identifier:resource,name:'Review admin',allowedScopes:['org:read'],accessTokenTtl:600})
 const input={clientId,name:'Review client',organizationId:org1,tokenEndpointAuthMethod:'client_secret_basic' as const,grantTypes:['client_credentials'] as ['client_credentials'],redirectUris:[],clientCredentialsScopes:['org:read']}
 const client=await clients.createClient(db,actor,input)
 await clients.linkResource(db,actor,clientId,resource)
 const auth=createAuth(db,environment), app=createApp({auth,db,environment})
 const eventsBeforeMint = await db.select({id:schema.auditEvents.id}).from(schema.auditEvents)
 const minted=await app.request('/auth/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${clientId}:${client.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',resource,scope:'org:read'})})
 const token=await minted.json()
 const previousIds = new Set(eventsBeforeMint.map(x=>x.id))
 results.tokenIssuanceAudit = (await db.select().from(schema.auditEvents)).filter(x=>!previousIds.has(x.id)).map(x=>x.action)
 if(minted.status!==200) throw new Error(`Mint failed: ${minted.status}`)
 const me=async()=>{const r=await app.request('/api/admin/v1/me',{headers:{Authorization:`Bearer ${token.access_token}`}});return {status:r.status,body:await r.json()}}
 const readOrg2=async()=>{const r=await app.request(`/api/admin/v1/organizations/${org2}`,{headers:{Authorization:`Bearer ${token.access_token}`}});return r.status}
 const first=await me()
 const accessBefore = await readOrg2()
 await clients.setOwner(db,actor,clientId,org2)
 const reassigned=await me()
 const accessAfter = await readOrg2()
 await clients.eraseClient(db,actor,clientId,clientId)
 const deleted=await me()
 await clients.createClient(db,actor,{...input,organizationId:org2})
 const recreated=await me()
 results.oldToken={first,reassigned,deleted,recreated,otherOrganisationRead:{before:accessBefore,after:accessAfter}}
 const rotation1=await clients.rotateSecret(db,actor,clientId)
 const rotation2=await clients.rotateSecret(db,actor,clientId)
 results.repeatedRotation={sameRequestId:actor.requestId,secretsDiffer:rotation1.clientSecret!==rotation2.clientSecret}
 console.log(JSON.stringify(results,null,2))
} finally {
 await db.delete(schema.oauthClients).where(eq(schema.oauthClients.clientId,clientId))
 await db.delete(schema.users).where(eq(schema.users.id,userId))
 await db.delete(schema.organizations).where(eq(schema.organizations.id,org1))
 await db.delete(schema.organizations).where(eq(schema.organizations.id,org2))
 await db.delete(schema.oauthResources).where(eq(schema.oauthResources.id,resourceId))
 await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorId,actor.actorId))
 await connection.close()
}
