
#ifndef XMLRPC_GBXSELF_TRANSPORT_H
#define XMLRPC_GBXSELF_TRANSPORT_H

#include "xmlrpc-c/transport.h"
#include "xmlrpc-c/server.h"
extern struct xmlrpc_client_transport_ops xmlrpc_gbx_transport_ops;


/* #include "bool.h" */
#ifndef BOOL_H_INCLUDED
#define BOOL_H_INCLUDED

#ifndef TRUE
#define TRUE (1)
#endif
#ifndef FALSE
#define FALSE (0)
#endif

#ifndef __cplusplus
#ifndef HAVE_BOOL
#define HAVE_BOOL
typedef int bool;
#endif
#endif

#endif /*BOOL_H_INCLUDED*/


extern void* Gbx_Init(void);
extern void Gbx_Release(void* _Gbx);

// Specify which server we should connect to.
//  _Url must be like: gbx://xx.xx.xx.xx:xx (only numeric address supported now.)
extern bool Gbx_ConnectTo(void* _Gbx, const char* _Url);

// Check if there are incomming messages. returns FALSE if the connection is broken.
// 		waits for _Timeout ms at most before returning. (0 = returns immediatly)
extern bool Gbx_Tick(void* _Gbx, xmlrpc_timeout _Timeout);	

// use this registry to register the callbacks you want.
extern xmlrpc_registry* Gbx_GetRegistry(void* _Gbx);



#endif
