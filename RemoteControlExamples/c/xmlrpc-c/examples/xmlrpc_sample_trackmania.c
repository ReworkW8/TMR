/* A simple asynchronous XML-RPC client written in C, as an example of
   Xmlrpc-c asynchronous RPC facilities.  This is the same as the 
   simpler synchronous client xmlprc_sample_add_client.c, except that
   it adds 3 different pairs of numbers with the summation RPCs going on
   simultaneously.
*/

#include <stdlib.h>
#include <stdio.h>

#include <xmlrpc-c/base.h>
#include <xmlrpc-c/client.h>
#include <xmlrpc-c/server.h>

#include "config.h"  /* information about this build environment */
#include "../lib/gbx_transport/xmlrpc_gbx_transport.h"

#define NAME "Xmlrpc-c Trackmania Test Client"
#define VERSION "1.0"

static const char * const url = "gbx://127.0.0.1";


/* ================================================================================================ */
/* Utility functions */
/* ================================================================================================ */

static void 
die_if_fault_occurred (xmlrpc_env *env) {
    if (env->fault_occurred) {
        fprintf(stderr, "Something failed. %s (XML-RPC fault code %d)\n",
                env->fault_string, env->fault_code);
        exit(1);
    }
}

static void 
handle_bool_response(const char *   const server_url,
                           const char *   const method_name,
                           xmlrpc_value * const param_array,
                           void *         const user_data ATTR_UNUSED,
                           xmlrpc_env *   const faultP,
                           xmlrpc_value * const resultP) {
    
    xmlrpc_env env;
    
    /* Initialize our error environment variable */
    xmlrpc_env_init(&env);

    if (faultP->fault_occurred)
        printf("The RPC failed.  %s", faultP->fault_string);
    else {
        xmlrpc_bool res;

        xmlrpc_read_bool(&env, resultP, &res);
        die_if_fault_occurred(&env);

        printf("The result is  %d\n", res);
    }
}

static int check_bool_response(xmlrpc_env* faultP, xmlrpc_value * resultP)
{
	if (faultP->fault_occurred) {
		printf("The RPC failed.  %s\n", faultP->fault_string);
		return FALSE;

	} else {
		xmlrpc_bool Res;

		xmlrpc_read_bool(faultP, resultP, &Res);
		die_if_fault_occurred(faultP);
		printf("The result is  %d\n", Res);

		return Res;
	}	
}

/* ================================================================================================ */
/* Simple sample (without callbacks) */
/* ================================================================================================ */

void sample_simple()
{
    xmlrpc_env env;
	xmlrpc_value* Result;


    printf("sample_simple()\n");

    /* Initialize our error environment variable */
    xmlrpc_env_init(&env);

    /* Create the Xmlrpc-c client object */
    xmlrpc_client_init2(&env, XMLRPC_CLIENT_NO_FLAGS, NAME, VERSION, NULL, 0);
    die_if_fault_occurred(&env);

	/* Authentify */
	Result = xmlrpc_client_call(&env, url, "Authenticate", "(ss)", "SuperAdmin", "SuperAdmin");
	if (!check_bool_response(&env, Result))
		return;
	xmlrpc_DECREF(Result); Result=NULL;

    /* request the remote procedure call */
    Result = xmlrpc_client_call(&env, url, "ChatSendServerMessage", "(s)", "hello world.");
	if (!check_bool_response(&env, Result))
		return;
	xmlrpc_DECREF(Result); Result=NULL;

    /* Destroy the Xmlrpc-c client object */
    xmlrpc_client_cleanup();	
}


/* ================================================================================================ */
/* Sample with callbacks */
/* ================================================================================================ */

static bool MustQuit = FALSE;

static xmlrpc_value *
PlayerChat(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) {

    xmlrpc_int32	PlayerUId;
	xmlrpc_bool		IsCmd;
	char* Login;
	char* Text;
	
    xmlrpc_decompose_value(env, param_array, "(issb)", &PlayerUId, &Login, &Text, &IsCmd);
    if (env->fault_occurred)
        return NULL;

	if (!IsCmd) {
		printf("Chat: %s said '%s'\n", Login, Text);
	} else {
		printf("[Cmd %s from %s]\n", Text, Login);
	}

	if (strcmp(Text, "exit") == 0)
		MustQuit = TRUE;

	free(Login);
	free(Text);

    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
BeginRace(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
	printf("--- Begin Race ---\n");
    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
EndRace(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
	xmlrpc_value * Rankings = NULL;
	xmlrpc_value * Challenge = NULL;
	int i,j, Count;

	printf("--- End Race ---\n");
	xmlrpc_decompose_value(env, param_array, "(AS)", &Rankings, &Challenge);

	if (env->fault_occurred)
	{
		return NULL;
	}

	Count = xmlrpc_array_size(env, Rankings);
	if (env->fault_occurred)
	{
		return NULL;
	}

	for (i=0; i<Count; i++) 
	{
		xmlrpc_value * Ranking = NULL;
		xmlrpc_value * BestCheckpoints;
		char* Login;
		int Time;
		int ChkptsCount;

		xmlrpc_array_read_item(env, Rankings, i, &Ranking);
		if (env->fault_occurred)
		{
			break;
		}

		xmlrpc_decompose_value(env, Ranking, "{s:s,s:i,s:A,*}", 
										"Login", &Login, 
										"BestTime", &Time, 
										"BestCheckpoints", &BestCheckpoints);

		xmlrpc_DECREF(Ranking);
		if (env->fault_occurred)
		{
			break;
		}

		printf("%s: %d (", Login, Time);
		
		ChkptsCount = xmlrpc_array_size(env, BestCheckpoints);

		for (j=0; j<ChkptsCount; j++) 
		{
			xmlrpc_value * ChkPt = NULL;
			int ChkptTime;
			xmlrpc_array_read_item(env, BestCheckpoints, j, &ChkPt);
			if (env->fault_occurred)
			{
				break;
			}
			xmlrpc_decompose_value(env, ChkPt, "i", &ChkptTime);
			xmlrpc_DECREF(ChkPt);
			printf("%d, ", ChkptTime);
		}

		printf(")\n");

		xmlrpc_DECREF(BestCheckpoints);
		free(Login);
	}

	xmlrpc_DECREF(Rankings);
	xmlrpc_DECREF(Challenge);

	if (!env->fault_occurred) 
	{
		///.....
	}

	if (env->fault_occurred)
	{
		return NULL;
	}

    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
BeginRound(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
	printf("--- Begin Round ---\n");
    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
StatusChanged(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
    xmlrpc_int32	StatusCode;
	char* 			StatusName;
    xmlrpc_decompose_value(env, param_array, "(is)", &StatusCode, &StatusName);
    if (env->fault_occurred)
        return NULL;
	printf("StatusChanged: %i / %s\n", StatusCode, StatusName);
	free(StatusName);
    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
PlayerConnect(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
    xmlrpc_bool		Spectator;
	char* 			Login;
    xmlrpc_decompose_value(env, param_array, "(sb)", &Login, &Spectator);
    if (env->fault_occurred)
        return NULL;
	printf("PlayerConnect: %s (as %s)\n", Login, Spectator?"spectator":"player");
	free(Login);
    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
PlayerCheckpoint(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
 	char Message[1024];
    xmlrpc_int32	PlayerUId;
    xmlrpc_int32	Time;
    xmlrpc_int32	Score;
    xmlrpc_int32	CheckpointIndex;
	xmlrpc_value*   Result;

	char* 			Login;
	
    xmlrpc_decompose_value(env, param_array, "(isiii)", &PlayerUId, &Login, &Time, &Score, &CheckpointIndex);
    if (env->fault_occurred)
        return NULL;

	printf("--- PlayerCheckpoint ---\n");
 
 	// echo...
 	sprintf(Message, "%s passed checkpoint nb %d. (time=%gs)", Login, CheckpointIndex, (Time*0.001f));
 	printf(Message); printf("\n");
 	
 	// send it to chat
   	Result = xmlrpc_client_call(env, url, "ChatSendServerMessage", "(s)", Message);
    if (env->fault_occurred)
        return NULL;
	xmlrpc_DECREF(Result); Result=NULL;		// ignore the result...
    
    return xmlrpc_build_value(env, "b", 1);
}

static xmlrpc_value *
PlayerFinish(xmlrpc_env *   const env, 
           xmlrpc_value * const param_array, 
           void *         const user_data ATTR_UNUSED) 
{
	printf("--- PlayerFinish ---\n");
    return xmlrpc_build_value(env, "b", 1);
}


void sample_with_callbacks()
{
    xmlrpc_env env;
	void* Gbx;
	xmlrpc_registry* Registry;
	xmlrpc_value* Result;


	printf("\n\nsample_with_callbacks():\n");

    /* Initialize our error environment variable */
    xmlrpc_env_init(&env);

	/* Register Callbacks */
	Gbx = Gbx_Init();
	Registry = Gbx_GetRegistry(Gbx);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.PlayerConnect", &PlayerConnect, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.PlayerChat", &PlayerChat, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.BeginRace", &BeginRace, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.BeginRound", &BeginRound, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.EndRace", &EndRace, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.PlayerCheckpoint", &PlayerCheckpoint, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.PlayerFinish", &PlayerFinish, NULL);
    xmlrpc_registry_add_method(&env, Registry, NULL, "TrackMania.StatusChanged", &StatusChanged, NULL);
	// and so on ...
	
	/* Create the Xmlrpc-c client object */
    xmlrpc_client_init2(&env, XMLRPC_CLIENT_NO_FLAGS, NAME, VERSION, NULL, 0);
    die_if_fault_occurred(&env);

	/* Authentify */

	Result = xmlrpc_client_call(&env, url, "Authenticate", "(ss)", "SuperAdmin", "SuperAdmin");

	if (!check_bool_response(&env, Result))

		return;

	xmlrpc_DECREF(Result); Result=NULL;


	/* Enable callbacks */

	Result = xmlrpc_client_call(&env, url, "EnableCallbacks", "(b)", TRUE);

	if (!check_bool_response(&env, Result))

		return;

	xmlrpc_DECREF(Result); Result=NULL;
	
    /* chat.. (example using async calls)*/
    xmlrpc_client_call_asynch(url, "ChatSendServerMessage",
                              handle_bool_response, NULL,
                              "(s)", "server running...");
    
    /*  uncomment the next line make sure all the async calls are finished before continuing. */
    /* xmlrpc_client_event_loop_finish_asynch();*/
    
	/* wait and process events */
	while (!MustQuit) {
		bool Ok = Gbx_Tick(Gbx, 1000);
		if (!Ok)
			break;
		printf("tick\n");
	}

    /* Destroy the Xmlrpc-c client object */
	Gbx_Release(Gbx);
    xmlrpc_client_cleanup();
}


int 
main(int           const argc, 
     const char ** const argv ATTR_UNUSED) {

    if (argc-1 > 0) {
        fprintf(stderr, "This program has no arguments\n");
        exit(1);
    }

	sample_simple();
	sample_with_callbacks();

    return 0;
}
