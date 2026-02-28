
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <malloc.h>

#ifndef _WIN32
	#include <netinet/in.h>
	#include <sys/time.h>
	#include <sys/socket.h>
	#include <errno.h>
	#define INVALID_SOCKET 0
	#define closesocket close
	#define SOCKET int
#else
	#include <Winsock2.h>
	#include <Windows.h>
#endif

#include "mallocvar.h"
#include "bool.h"

#include "xmlrpc_config.h"
#include "xmlrpc-c/base.h"
#include "xmlrpc-c/base_int.h"
#include "xmlrpc-c/server.h"
#include "xmlrpc-c/client.h"
#include "xmlrpc-c/client_int.h"
#include "xmlrpc-c/transport.h"

#include "xmlrpc_gbx_transport.h"

static bool Gbx_SendRequest(unsigned int _Handle, size_t _Len, const char* _Xml);
static void Gbx_ReceiveResult(struct xmlrpc_client_transport * clientTransportP, unsigned int _Handle, xmlrpc_mem_block * _Xml, const char* _Error);
static void Gbx_CancelCallsInProgress(struct xmlrpc_client_transport * clientTransportP);
static bool Gbx_TickInternal(void* _Gbx, xmlrpc_timeout _Timeout, bool _ProcessCallbacks);


static xmlrpc_timeout Gbx_GetTime(void);

#define DCallbacksQueue_Size 64
#define DDefaultTimeout	10000

/* ==========================================================================
		Client.
   ========================================================================== */

struct xmlrpc_client_transport
{
	int 				RefCount;
	uint32_t	 		NextHandle;
	struct _xmlrpc_registry*	Registry;
	SOCKET				Socket;
	struct sockaddr_in	CurAddr;
	xmlrpc_mem_block*	CallbacksQueue_Data[DCallbacksQueue_Size];
	int					CallbacksQueue_Handle[DCallbacksQueue_Size];
	int					CallbacksQueue_Count;

	uint32_t							CurRequest_Handle;
	xmlrpc_timeout 						CurRequest_SentTime;
	xmlrpc_transport_asynch_complete	CurRequest_CompleteCallback;
	struct xmlrpc_call_info *       	CurRequest_callInfoP;
};

static void create(
    xmlrpc_env *                      const envP,
    int                               const flags,
    const char *                      const appname,
    const char *                      const appversion,
    const struct xmlrpc_xportparms *  const transportparmsP,
    size_t                            const transportparm_size,
    struct xmlrpc_client_transport ** const handlePP)
{
	(*handlePP) = Gbx_Init();
}

static void destroy(
    struct xmlrpc_client_transport * const clientTransportP)
{
	XMLRPC_ASSERT(clientTransportP != NULL);
	Gbx_Release(clientTransportP);
}

static void finishAsynch(
    struct xmlrpc_client_transport * const clientTransportP,
    xmlrpc_timeoutType               const _timeoutType,
    xmlrpc_timeout                   const _timeout)
{
    xmlrpc_timeoutType  timeoutType = _timeoutType;
    xmlrpc_timeout		timeout = _timeout;

	XMLRPC_ASSERT(clientTransportP != NULL);
	
	// Force a timeout even if we weren't asked for one,
	// so that we never get struck in this infinite loop.
	if (timeoutType != timeout_yes) {
		timeoutType = timeout_yes;
		timeout = DDefaultTimeout;
	}

	while (clientTransportP->CurRequest_Handle) {
		bool Ok = Gbx_TickInternal(clientTransportP, 1000, FALSE);
		
		if (timeoutType == timeout_yes || !Ok) {
			if (clientTransportP->CurRequest_SentTime + timeout < Gbx_GetTime() || !Ok) {
				Gbx_ReceiveResult(clientTransportP, clientTransportP->CurRequest_Handle, NULL, "Timeout");
			}
		}
	}
}

static xmlrpc_env * call_envP;
static xmlrpc_mem_block** call_responsePP;

static void 
handle_call_complete(struct xmlrpc_call_info * const callInfoP,
				    xmlrpc_mem_block *        const responseXmlP,
				    xmlrpc_env                const env)
{
	if (env.fault_occurred) {
		(*call_responsePP) = NULL;
		xmlrpc_env_set_fault(call_envP, env.fault_code, env.fault_string);
		
	} else {
		(*call_responsePP) = XMLRPC_MEMBLOCK_NEW(char, call_envP, 0);
		xmlrpc_mem_block_append(call_envP, (*call_responsePP), 
					XMLRPC_MEMBLOCK_CONTENTS(char, responseXmlP), XMLRPC_MEMBLOCK_SIZE(char, responseXmlP));
	}
}
             
static void call(
    xmlrpc_env *                     const envP,
    struct xmlrpc_client_transport * const clientTransportP,
    const xmlrpc_server_info *       const serverP,
    xmlrpc_mem_block *               const xmlP,
    xmlrpc_mem_block **              const responsePP)
{
	bool Connected, Sent;

    XMLRPC_ASSERT_ENV_OK(envP);
    XMLRPC_ASSERT_PTR_OK(serverP);
    XMLRPC_ASSERT_PTR_OK(xmlP);
	XMLRPC_ASSERT(clientTransportP != NULL);

	call_envP = envP;
	call_responsePP = responsePP;
	*responsePP = NULL;
	
	if (clientTransportP->CurRequest_Handle != 0) {
		xmlrpc_env_set_fault_formatted(envP, XMLRPC_INTERNAL_ERROR, "Only one call at a time supported.");
		return;
	}
	
	Connected = Gbx_ConnectTo(clientTransportP, serverP->_server_url);
    if (!Connected) {
		xmlrpc_env_set_fault_formatted(envP, XMLRPC_NETWORK_ERROR, "Could not connect to '%s'.", serverP->_server_url);
		return;
	}
	
	clientTransportP->NextHandle++;
	clientTransportP->NextHandle = clientTransportP->NextHandle | 0x80000000;
	Sent = Gbx_SendRequest(clientTransportP->NextHandle, XMLRPC_MEMBLOCK_SIZE(char, xmlP), XMLRPC_MEMBLOCK_CONTENTS(char, xmlP));
    if (!Sent) {
		xmlrpc_env_set_fault_formatted(envP, XMLRPC_NETWORK_ERROR, "Could not deliver the call.");
		return;
	} else {
		clientTransportP->CurRequest_Handle = clientTransportP->NextHandle;
		clientTransportP->CurRequest_SentTime = Gbx_GetTime();
		clientTransportP->CurRequest_CompleteCallback = &handle_call_complete;
		clientTransportP->CurRequest_callInfoP = (void*)responsePP;
	}
	
	finishAsynch(clientTransportP, timeout_yes, DDefaultTimeout);
}


static void sendRequest(
    xmlrpc_env *                     const envP, 
    struct xmlrpc_client_transport * const clientTransportP,
    const xmlrpc_server_info *       const serverP,
    xmlrpc_mem_block *               const xmlP,
    xmlrpc_transport_asynch_complete       complete,
    struct xmlrpc_call_info *        const callInfoP)
{
	bool Connected, Sent;

    XMLRPC_ASSERT_ENV_OK(envP);
    XMLRPC_ASSERT_PTR_OK(serverP);
    XMLRPC_ASSERT_PTR_OK(xmlP);
	XMLRPC_ASSERT(clientTransportP != NULL);

	if (clientTransportP->CurRequest_Handle != 0) {
		xmlrpc_env_set_fault_formatted(envP, XMLRPC_INTERNAL_ERROR, "Only one call at a time supported.");
		return;
	}
	
	Connected = Gbx_ConnectTo(clientTransportP, serverP->_server_url);
    if (!Connected) {
		xmlrpc_env_set_fault_formatted(envP, XMLRPC_NETWORK_ERROR, "Could not connect to '%s'.", serverP->_server_url);
		return;
	}

	clientTransportP->NextHandle++;
	clientTransportP->NextHandle = clientTransportP->NextHandle | 0x80000000;
	Sent = Gbx_SendRequest(clientTransportP->NextHandle, XMLRPC_MEMBLOCK_SIZE(char, xmlP), XMLRPC_MEMBLOCK_CONTENTS(char, xmlP));
    if (!Sent) {
		xmlrpc_env_set_fault_formatted(envP, XMLRPC_NETWORK_ERROR, "Could not deliver the call.");
		return;
	} else {
		clientTransportP->CurRequest_Handle = clientTransportP->NextHandle;
		clientTransportP->CurRequest_SentTime = Gbx_GetTime();
		clientTransportP->CurRequest_CompleteCallback = complete;
		clientTransportP->CurRequest_callInfoP = callInfoP;
	}
}

// ======================================
// Publish Ops table:
struct xmlrpc_client_transport_ops xmlrpc_gbx_transport_ops = {
    &create,
    &destroy,
    &sendRequest,
    &call,
    &finishAsynch,
};



/* ==========================================================================
		Protocol Implementation.
   ========================================================================== */

static struct xmlrpc_client_transport* GbxInternal = NULL;
#ifdef _WIN32
	static WSADATA WSA_Data = {0};
#endif

static bool ReadData(int _Socket, void* _Data, int _Len)
{
	char* Data = (char*)_Data;
	int Recev = 0;
	do {
		Recev = recv(_Socket, Data, _Len, 0);
		if (Recev <= 0)
			return FALSE;
		_Len -= Recev;
		Data += Recev;
	} while (_Len>0);
	return TRUE;
}

static bool WriteData(int _Socket, const void* _Data, int _Len)
{
	const char* Data = (const char*)_Data;
	int Written = 0;
	do {
		Written = send(_Socket, Data, _Len, 0);
		if (Written < 0)
			return FALSE;
		_Len -= Written;
		Data += Written;
	} while (_Len>0);
	return TRUE;
}

void* Gbx_Init()
{
	xmlrpc_env env;

	if (!GbxInternal) {
#ifdef _WIN32
		if (WSA_Data.wVersion == 0) 
		{
			// Winsock not yet initialised.

			int Err;
			WORD VersionRequested;
			VersionRequested = MAKEWORD( 2, 2 );
 
			#pragma comment(lib, "ws2_32.lib")
			Err = WSAStartup( VersionRequested, &WSA_Data );
			if ( Err != 0 ) 
			{
				/* Tell the user that we could not find a usable */
				/* WinSock DLL.                                  */
				WSA_Data.wVersion = 0;
				return NULL;
			}

			/* Confirm that the WinSock DLL supports 2.2.*/
			/* Note that if the DLL supports versions greater    */
			/* than 2.2 in addition to 2.2, it will still return */
			/* 2.2 in wVersion since that is the version we      */
			/* requested.                                        */
 
			if ( LOBYTE( WSA_Data.wVersion ) != 2 ||
					HIBYTE( WSA_Data.wVersion ) != 2 ) {
				/* Tell the user that we could not find a usable */
				/* WinSock DLL.                                  */
				WSACleanup( );
				WSA_Data.wVersion = 0;
				return NULL; 
			}
			/* The WinSock DLL is acceptable. Proceed. */
		}
#endif

		MALLOCVAR(GbxInternal);
		if (!GbxInternal)
			return NULL;
			
		xmlrpc_env_init(&env);
	
	    GbxInternal->NextHandle = 0x80000000;
	    GbxInternal->RefCount = 0;
		GbxInternal->Registry = xmlrpc_registry_new(&env);
		if (env.fault_occurred)
			goto label_error;
		
		GbxInternal->Socket = INVALID_SOCKET;
		GbxInternal->CallbacksQueue_Count = 0;

	    GbxInternal->CurRequest_Handle = 0;
	}
	GbxInternal->RefCount++;
	return GbxInternal;
	
label_error:
	free(GbxInternal); 
	GbxInternal = NULL;
	return NULL;	
}

xmlrpc_registry* Gbx_GetRegistry(void* _Gbx)
{
	XMLRPC_ASSERT(GbxInternal && GbxInternal == _Gbx);
	return GbxInternal->Registry;
}

void Gbx_Release(void* _Gbx)
{
	XMLRPC_ASSERT(GbxInternal && GbxInternal == _Gbx);
	GbxInternal->RefCount--;
	if (GbxInternal->RefCount == 0) {
		xmlrpc_registry_free(GbxInternal->Registry);

		if (GbxInternal->Socket != INVALID_SOCKET) {
			closesocket(GbxInternal->Socket); 
			GbxInternal->Socket = INVALID_SOCKET;
		}

		free (GbxInternal);
		GbxInternal = NULL;

#ifdef _WIN32
		if (WSA_Data.wVersion) {

			/* Clean up windows networking */
			if ( WSACleanup() == SOCKET_ERROR ) {
				if ( WSAGetLastError() == WSAEINPROGRESS ) {
					WSACancelBlockingCall();
					WSACleanup();
				}
			}

			WSA_Data.wVersion = 0;
		}
#endif
	}
}

static bool ConnectionError()
{
 	if (GbxInternal && GbxInternal->Socket != INVALID_SOCKET) {
 		closesocket(GbxInternal->Socket); 
		GbxInternal->Socket = INVALID_SOCKET;
	}
#ifdef _WIN32
	fprintf(stderr, "** Socket Error %d\n", WSAGetLastError());
#else
	fprintf(stderr, "** Socket Error %d (%m)\n", errno);
#endif
	return FALSE;
}

bool Gbx_ConnectTo(void* _Gbx, const char* _Url)
{
	struct xmlrpc_client_transport * clientTransportP = (struct xmlrpc_client_transport *)_Gbx;
	int IP1, IP2, IP3, IP4, Port=0;
	int Num;
	struct sockaddr_in Addr, AddrAny;
	uint32_t 	Size;
	bool Ok;
	char* Handshake;

	XMLRPC_ASSERT(GbxInternal && GbxInternal == _Gbx);
	
	Num = sscanf(_Url, "gbx://%d.%d.%d.%d:%d", &IP1, &IP2, &IP3, &IP4, &Port);

	if ( (Num < 4 || Num > 5)
		|| IP1>255 || IP2>255 || IP3>255 || IP4>255 || (Num == 5 && Port>65535)) 
	{
		return FALSE;	
	}
	
	if (Num < 5 || Port == 0) {
		Port = 5000;
	}

	memset(&Addr, 0, sizeof(Addr));
	Addr.sin_family = AF_INET; 
	Addr.sin_port = htons (Port); 
	Addr.sin_addr.s_addr = htonl (((IP1<<24)&0xFF000000) | ((IP2<<16)&0x00FF0000) | ((IP3<<8)&0x0000FF00) | ((IP4<<0)&0x000000FF));
	if (GbxInternal->Socket != INVALID_SOCKET && memcmp(&Addr, &GbxInternal->CurAddr, sizeof(Addr)) == 0) {
		return TRUE;
	}

	if (GbxInternal->Socket != INVALID_SOCKET) {
		closesocket(GbxInternal->Socket); 
		GbxInternal->Socket = INVALID_SOCKET;
	}
	
	GbxInternal->Socket = socket( PF_INET, SOCK_STREAM, 0 ); 
	if (GbxInternal->Socket == INVALID_SOCKET)
		return FALSE;
	memset(&AddrAny, 0, sizeof(AddrAny));
	AddrAny.sin_family = AF_INET; 
	AddrAny.sin_port = 0; 
	AddrAny.sin_addr.s_addr = htonl (INADDR_ANY);
	if (bind (GbxInternal->Socket, (struct sockaddr*)&AddrAny, sizeof(AddrAny)) != 0) {
		return ConnectionError();
	}

	if (connect(GbxInternal->Socket, (struct sockaddr*)&Addr, sizeof(Addr)) == 0) {
		memcpy(&GbxInternal->CurAddr, &Addr, sizeof(Addr));
	} else {
		return ConnectionError();	
	}
	
	// handshake
	Ok = ReadData(GbxInternal->Socket, &Size, 4);
	if (!Ok) {
		return ConnectionError();	
	}
	
	Handshake = alloca(Size+1);
	Ok = ReadData(GbxInternal->Socket, Handshake, Size);
	Handshake[Size]=0;
	if (!Ok || strcmp(Handshake, "GBXRemote 2") != 0) {
		return ConnectionError();	
	}
	
	return TRUE;
}


#ifdef _WIN32

DWORD InitTime = 0;
static xmlrpc_timeout Gbx_GetTime() 
{
	DWORD Now = GetTickCount();
	if (InitTime == 0) {
		InitTime = Now;
	}
	return Now-InitTime;
}

#else

static struct timeval InitTime = {0,0};
static xmlrpc_timeout Gbx_GetTime() 
{
	struct timeval Now;
	gettimeofday(&Now, NULL);
	if (InitTime.tv_sec == 0 && InitTime.tv_usec == 0) {
		InitTime = Now;
	}
	return (Now.tv_sec-InitTime.tv_sec)*1000+(Now.tv_usec-InitTime.tv_usec)/1000;
}

#endif


static bool Gbx_SendRequest(unsigned int _Handle, size_t _Len, const char* _Xml)
{
	XMLRPC_ASSERT(GbxInternal && GbxInternal->Socket != INVALID_SOCKET);
	if (!WriteData(GbxInternal->Socket, &_Len, 4))
		return ConnectionError();
	if (!WriteData(GbxInternal->Socket, &_Handle, 4))
		return ConnectionError();
	if (!WriteData(GbxInternal->Socket, _Xml, _Len))
		return ConnectionError();
	return TRUE;
}

static void Gbx_ReceiveResult(struct xmlrpc_client_transport * clientTransportP, unsigned int _Handle, xmlrpc_mem_block * _Xml, const char* _Error)
{	
	xmlrpc_env env;

	if (!_Handle || clientTransportP->CurRequest_Handle != _Handle) {
		// this is not a result we're expecting. just ignore it.
		return;
	}

	xmlrpc_env_init(&env);

	if (!_Error) {
		(*clientTransportP->CurRequest_CompleteCallback)(clientTransportP->CurRequest_callInfoP, _Xml, env);
	} else {
		xmlrpc_env_set_fault(&env, XMLRPC_NETWORK_ERROR, _Error);
		(*clientTransportP->CurRequest_CompleteCallback)(clientTransportP->CurRequest_callInfoP, NULL, env);
	}

	xmlrpc_env_clean(&env);
	clientTransportP->CurRequest_callInfoP = NULL;
	clientTransportP->CurRequest_Handle = 0;	// no longer expecting the call.
	clientTransportP->CurRequest_CompleteCallback = NULL;
}

static void Gbx_CancelCallsInProgress(struct xmlrpc_client_transport * clientTransportP)
{
	if( !clientTransportP->CurRequest_Handle )
		return;				

	Gbx_ReceiveResult(clientTransportP, clientTransportP->CurRequest_Handle, NULL, "Call canceled");
}

static void Gbx_ProcessCallbacks(void* _Gbx)
{
	while (GbxInternal->CallbacksQueue_Count > 0) {
		xmlrpc_env env;
		xmlrpc_mem_block* XmlData;
		xmlrpc_mem_block * Output = NULL;
		int Handle;

		// dequeue
		XmlData = GbxInternal->CallbacksQueue_Data[0];
		Handle = GbxInternal->CallbacksQueue_Handle[0];
		GbxInternal->CallbacksQueue_Count --;
		memmove(&GbxInternal->CallbacksQueue_Data[0], &GbxInternal->CallbacksQueue_Data[1], GbxInternal->CallbacksQueue_Count*sizeof(GbxInternal->CallbacksQueue_Data[0]));
		memmove(&GbxInternal->CallbacksQueue_Handle[0], &GbxInternal->CallbacksQueue_Handle[1], GbxInternal->CallbacksQueue_Count*sizeof(GbxInternal->CallbacksQueue_Handle[0]));

		// process
		xmlrpc_env_init(&env);
		
		Output = xmlrpc_registry_process_call(
							&env, GbxInternal->Registry, NULL, 
							XMLRPC_MEMBLOCK_CONTENTS(char,XmlData), XMLRPC_MEMBLOCK_SIZE(char, XmlData));	

		if (!env.fault_occurred) {
			Gbx_SendRequest(Handle, XMLRPC_MEMBLOCK_SIZE(char, Output), XMLRPC_MEMBLOCK_CONTENTS(char,Output));
		}

		xmlrpc_env_clean(&env);
		if(Output)
			XMLRPC_MEMBLOCK_FREE(char, Output);

		XMLRPC_MEMBLOCK_FREE(char, XmlData);
	}
}


static bool Gbx_TickInternal(void* _Gbx, xmlrpc_timeout _Timeout, bool _ProcessCallbacks)
{
	struct timeval tv;
	fd_set mask_read;
	int NbReady;

	XMLRPC_ASSERT(GbxInternal && GbxInternal == _Gbx);

	// process callsbacks in the queue
	if (_ProcessCallbacks) {
		Gbx_ProcessCallbacks(GbxInternal);
	}

	if (GbxInternal->Socket == INVALID_SOCKET) {
		return FALSE;
	}
	
	FD_ZERO(&mask_read);
	FD_SET(GbxInternal->Socket, &mask_read);
		
	// Set up the timeout (0 to have a non-blocking call)
	tv.tv_sec = _Timeout/1000;
	tv.tv_usec = (_Timeout%1000)*1000;

	NbReady = select(FD_SETSIZE, &mask_read, NULL, NULL, &tv);
	if (NbReady == -1) 
	{
#ifdef _WIN32
		if (WSAGetLastError() != WSAEINTR)
#else
		if (errno != EINTR)
#endif
		{
			return ConnectionError();
		}
		
	}
	else if (NbReady!=0) 
	{
		xmlrpc_env env;
		xmlrpc_mem_block* XmlData;
		unsigned int Len;
		int Handle;
		bool Error;

		if (!ReadData(GbxInternal->Socket, &Len, 4) || Len==0 || Len>=xmlrpc_limit_get(XMLRPC_XML_SIZE_LIMIT_ID))
			return ConnectionError();
		if (!ReadData(GbxInternal->Socket, &Handle, 4) || Handle==0)
			return ConnectionError();
		
		xmlrpc_env_init(&env);
		XmlData = XMLRPC_MEMBLOCK_NEW(char, &env, Len);
		Error = env.fault_occurred;
		xmlrpc_env_clean(&env);	
		if (Error) 
			return FALSE;
			
		if (!ReadData(GbxInternal->Socket, XMLRPC_MEMBLOCK_CONTENTS(char,XmlData), Len)) {
			XMLRPC_MEMBLOCK_FREE(char, XmlData);
			return ConnectionError();
		}
			
		if (Handle<0) {
			// result of some call
			Gbx_ReceiveResult(GbxInternal, Handle, XmlData, NULL);
			XMLRPC_MEMBLOCK_FREE(char, XmlData);

		} else {
			// incomming call
			XMLRPC_ASSERT(GbxInternal->CallbacksQueue_Count < DCallbacksQueue_Size);		// Queue overflow. Call Gbx_Tick more often!!!!
			GbxInternal->CallbacksQueue_Data[GbxInternal->CallbacksQueue_Count] = XmlData;
			GbxInternal->CallbacksQueue_Handle[GbxInternal->CallbacksQueue_Count] = Handle;
			GbxInternal->CallbacksQueue_Count++;
		}
	}
	
	// process callsbacks in the queue, without waiting for the next Gbx_Tick call.. (not really needed)
	if (_ProcessCallbacks) {
		Gbx_ProcessCallbacks(GbxInternal);
	}

	return TRUE;
}

bool Gbx_Tick(void* _Gbx, xmlrpc_timeout _Timeout)
{
	return Gbx_TickInternal(_Gbx, _Timeout, TRUE);
}
