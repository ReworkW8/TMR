ifeq ($(SRCDIR)x,x)
SRCDIR = $(CURDIR)/../..
endif

include $(SRCDIR)/Makefile.config

CFLAGS = $(CFLAGS_COMMON) $(CFLAGS_PERSONAL) $(CADD)
LDFLAGS = -llibxmlrpc_server $(LADD)

INCLUDES = -I$(SRCDIR) -I$(SRCDIR)/include -I$(SRCDIR)/lib/util/include 

default: all

.PHONY: all
all: xmlrpc_gbx_transport.lo

.PHONY: clean
clean: clean-common

.PHONY: distclean
distclean: clean distclean-common

.PHONY: tags
tags: TAGS

.PHONY: distdir
distdir:

.PHONY: install
install:

.PHONY: dep
dep: dep-common

include $(SRCDIR)/Makefile.common

include Makefile.depend

xmlrpc_gbx_transport.lo:%.lo:%.c
	$(LIBTOOL) --mode=compile $(CC) -c $(INCLUDES) $(CFLAGS) $<
