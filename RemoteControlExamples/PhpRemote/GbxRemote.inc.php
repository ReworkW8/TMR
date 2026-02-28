<?php

/* 
   IXR - The Inutio XML-RPC Library - (c) Incutio Ltd 2002
   Version 1.61 - Simon Willison, 11th July 2003 (htmlentities -> htmlspecialchars)
   Site:   http://scripts.incutio.com/xmlrpc/
   Manual: http://scripts.incutio.com/xmlrpc/manual.php
   Made available under the Artistic License: http://www.opensource.org/licenses/artistic-license.php

   Modified to support protocol "GbxRemote 2" ("GbxRemote 1")
*/


class IXR_Value {
    var $data;
    var $type;

    function IXR_Value ($data, $type = false) {
        $this->data = $data;
        if (!$type) {
            $type = $this->calculateType();
        }
        $this->type = $type;
        if ($type == 'struct') {
            /* Turn all the values in the array in to new IXR_Value objects */
            foreach ($this->data as $key => $value) {
                $this->data[$key] = new IXR_Value($value);
            }
        }
        if ($type == 'array') {
            for ($i = 0, $j = count($this->data); $i < $j; $i++) {
                $this->data[$i] = new IXR_Value($this->data[$i]);
            }
        }
    }

    function calculateType() {
        if ($this->data === true || $this->data === false) {
            return 'boolean';
        }
        if (is_integer($this->data)) {
            return 'int';
        }
        if (is_double($this->data)) {
            return 'double';
        }
        // Deal with IXR object types base64 and date
        if (is_object($this->data) && is_a($this->data, 'IXR_Date')) {
            return 'date';
        }
        if (is_object($this->data) && is_a($this->data, 'IXR_Base64')) {
            return 'base64';
        }
        // If it is a normal PHP object convert it in to a struct
        if (is_object($this->data)) {
            
            $this->data = get_object_vars($this->data);
            return 'struct';
        }
        if (!is_array($this->data)) {
            return 'string';
        }
        /* We have an array - is it an array or a struct ? */
        if ($this->isStruct($this->data)) {
            return 'struct';
        } else {
            return 'array';
        }
    }

    function getXml() {
        /* Return XML for this value */
        switch ($this->type) {
            case 'boolean':
                return '<boolean>'.(($this->data) ? '1' : '0').'</boolean>';
                break;
            case 'int':
                return '<int>'.$this->data.'</int>';
                break;
            case 'double':
                return '<double>'.$this->data.'</double>';
                break;
            case 'string':
                return '<string>'.htmlspecialchars($this->data).'</string>';
                break;
            case 'array':
                $return = '<array><data>'."\n";
                foreach ($this->data as $item) {
                    $return .= '  <value>'.$item->getXml()."</value>\n";
                }
                $return .= '</data></array>';
                return $return;
                break;
            case 'struct':
                $return = '<struct>'."\n";
                foreach ($this->data as $name => $value) {
                    $return .= "  <member><name>$name</name><value>";
                    $return .= $value->getXml()."</value></member>\n";
                }
                $return .= '</struct>';
                return $return;
                break;
            case 'date':
            case 'base64':
                return $this->data->getXml();
                break;
        }
        return false;
    }

    function isStruct($array) {
        /* Nasty function to check if an array is a struct or not */
        $expected = 0;
        foreach ($array as $key => $value) {
            if ((string)$key != (string)$expected) {
                return true;
            }
            $expected++;
        }
        return false;
    }
}


class IXR_Message {
    var $message;
    var $messageType;  // methodCall / methodResponse / fault
    var $faultCode;
    var $faultString;
    var $methodName;
    var $params;
    // Current variable stacks
    var $_arraystructs = array();   // The stack used to keep track of the current array/struct
    var $_arraystructstypes = array(); // Stack keeping track of if things are structs or array
    var $_currentStructName = array();  // A stack as well
    var $_param;
    var $_value;
    var $_currentTag;
    var $_currentTagContents;
    // The XML parser
    var $_parser;

    function IXR_Message ($message) {
        $this->message = $message;
    }

    function parse() {
        // first remove the XML declaration
        $this->message = preg_replace('/<\?xml(.*)?\?'.'>/', '', $this->message);
        if (trim($this->message) == '') {
            return false;
        }
        $this->_parser = xml_parser_create();
        // Set XML parser to take the case of tags in to account
        xml_parser_set_option($this->_parser, XML_OPTION_CASE_FOLDING, false);
        // Set XML parser callback functions
        xml_set_object($this->_parser, $this);
        xml_set_element_handler($this->_parser, 'tag_open', 'tag_close');
        xml_set_character_data_handler($this->_parser, 'cdata');
        if (!xml_parse($this->_parser, $this->message)) {
            /* die(sprintf('XML error: %s at line %d',
                xml_error_string(xml_get_error_code($this->_parser)),
                xml_get_current_line_number($this->_parser))); */
            return false;
        }
        xml_parser_free($this->_parser);
        // Grab the error messages, if any
        if ($this->messageType == 'fault') {
            $this->faultCode = $this->params[0]['faultCode'];
            $this->faultString = $this->params[0]['faultString'];
        }
        return true;
    }

    function tag_open($parser, $tag, $attr) {
        $this->currentTag = $tag;
        switch($tag) {
            case 'methodCall':
            case 'methodResponse':
            case 'fault':
                $this->messageType = $tag;
                break;
            /* Deal with stacks of arrays and structs */
            case 'data':    // data is to all intents and puposes more interesting than array
                $this->_arraystructstypes[] = 'array';
                $this->_arraystructs[] = array();
                break;
            case 'struct':
                $this->_arraystructstypes[] = 'struct';
                $this->_arraystructs[] = array();
                break;
        }
    }

    function cdata($parser, $cdata) {
        $this->_currentTagContents .= $cdata;
    }

    function tag_close($parser, $tag) {
        $valueFlag = false;
        switch($tag) {
            case 'int':
            case 'i4':
                $value = (int)trim($this->_currentTagContents);
                $this->_currentTagContents = '';
                $valueFlag = true;
                break;
            case 'double':
                $value = (double)trim($this->_currentTagContents);
                $this->_currentTagContents = '';
                $valueFlag = true;
                break;
            case 'string':
                $value = (string)trim($this->_currentTagContents);
                $this->_currentTagContents = '';
                $valueFlag = true;
                break;
            case 'dateTime.iso8601':
                $value = new IXR_Date(trim($this->_currentTagContents));
                // $value = $iso->getTimestamp();
                $this->_currentTagContents = '';
                $valueFlag = true;
                break;
            case 'value':
                // "If no type is indicated, the type is string."
                if (trim($this->_currentTagContents) != '') {
                    $value = (string)$this->_currentTagContents;
                    $this->_currentTagContents = '';
                    $valueFlag = true;
                }
                break;
            case 'boolean':
                $value = (boolean)trim($this->_currentTagContents);
                $this->_currentTagContents = '';
                $valueFlag = true;
                break;
            case 'base64':
                $value = base64_decode($this->_currentTagContents);
                $this->_currentTagContents = '';
                $valueFlag = true;
                break;
            /* Deal with stacks of arrays and structs */
            case 'data':
            case 'struct':
                $value = array_pop($this->_arraystructs);
                array_pop($this->_arraystructstypes);
                $valueFlag = true;
                break;
            case 'member':
                array_pop($this->_currentStructName);
                break;
            case 'name':
                $this->_currentStructName[] = trim($this->_currentTagContents);
                $this->_currentTagContents = '';
                break;
            case 'methodName':
                $this->methodName = trim($this->_currentTagContents);
                $this->_currentTagContents = '';
                break;
        }
        if ($valueFlag) {
            /*
            if (!is_array($value) && !is_object($value)) {
                $value = trim($value);
            }
            */
            if (count($this->_arraystructs) > 0) {
                // Add value to struct or array
                if ($this->_arraystructstypes[count($this->_arraystructstypes)-1] == 'struct') {
                    // Add to struct
                    $this->_arraystructs[count($this->_arraystructs)-1][$this->_currentStructName[count($this->_currentStructName)-1]] = $value;
                } else {
                    // Add to array
                    $this->_arraystructs[count($this->_arraystructs)-1][] = $value;
                }
            } else {
                // Just add as a paramater
                $this->params[] = $value;
            }
        }
    }       
}


class IXR_Request {
    var $method;
    var $args;
    var $xml;

    function IXR_Request($method, $args) {
        $this->method = $method;
        $this->args = $args;
        $this->xml = <<<EOD
<?xml version="1.0"?>
<methodCall>
<methodName>{$this->method}</methodName>
<params>

EOD;
        foreach ($this->args as $arg) {
            $this->xml .= '<param><value>';
            $v = new IXR_Value($arg);
            $this->xml .= $v->getXml();
            $this->xml .= "</value></param>\n";
        }
        $this->xml .= '</params></methodCall>';
    }

    function getLength() {
        return strlen($this->xml);
    }

    function getXml() {
        return $this->xml;
    }
}


class IXR_Error {
    var $code;
    var $message;

    function IXR_Error($code, $message) {
        $this->code = $code;
        $this->message = $message;
    }

    function getXml() {
        $xml = <<<EOD
<methodResponse>
  <fault>
    <value>
      <struct>
        <member>
          <name>faultCode</name>
          <value><int>{$this->code}</int></value>
        </member>
        <member>
          <name>faultString</name>
          <value><string>{$this->message}</string></value>
        </member>
      </struct>
    </value>
  </fault>
</methodResponse> 

EOD;
        return $xml;
    }
}


class IXR_Date {
    var $year;
    var $month;
    var $day;
    var $hour;
    var $minute;
    var $second;

    function IXR_Date($time) {
        // $time can be a PHP timestamp or an ISO one
        if (is_numeric($time)) {
            $this->parseTimestamp($time);
        } else {
            $this->parseIso($time);
        }
    }

    function parseTimestamp($timestamp) {
        $this->year = date('Y', $timestamp);
        $this->month = date('Y', $timestamp);
        $this->day = date('Y', $timestamp);
        $this->hour = date('H', $timestamp);
        $this->minute = date('i', $timestamp);
        $this->second = date('s', $timestamp);
    }

    function parseIso($iso) {
        $this->year = substr($iso, 0, 4);
        $this->month = substr($iso, 4, 2); 
        $this->day = substr($iso, 6, 2);
        $this->hour = substr($iso, 9, 2);
        $this->minute = substr($iso, 12, 2);
        $this->second = substr($iso, 15, 2);
    }

    function getIso() {
        return $this->year.$this->month.$this->day.'T'.$this->hour.':'.$this->minute.':'.$this->second;
    }

    function getXml() {
        return '<dateTime.iso8601>'.$this->getIso().'</dateTime.iso8601>';
    }

    function getTimestamp() {
        return mktime($this->hour, $this->minute, $this->second, $this->month, $this->day, $this->year);
    }
}


class IXR_Base64 {
    var $data;

    function IXR_Base64($data) {
        $this->data = $data;
    }

    function getXml() {
        return '<base64>'.base64_encode($this->data).'</base64>';
    }
}


//////////////////////////////////////////////////////////
// Nadeo modifications									//
//  (many thanks to slig for adding callback support)	//
//////////////////////////////////////////////////////////
class IXR_Client_Gbx {
	var $socket;
    var $message = false;
	var $cb_message = array();
	var $reqhandle;
	var $protocol = 0;
    // Storage place for an error message
    var $error = false;

	function IXR_Client_Gbx() {
		$this->socket = false;
		$this->reqhandle = 0x80000000;
	}

    function InitWithIp($ip,$port) {
	// open connection
        $this->socket = @fsockopen($ip, $port);
        if (!$this->socket) {
            $this->error = new IXR_Error(-32300, 'transport error - could not open socket');
            return false;
        }
		// handshake
		$array_result = unpack("Vsize", fread($this->socket, 4));
		$size = $array_result["size"];
		if($size > 64) {
            $this->error = new IXR_Error(-32300, 'transport error - wrong lowlevel protocol header');
            return false;
		}
		$handshake = fread($this->socket, $size);
		if ($handshake == "GBXRemote 1") {
			$this->protocol = 1;
		} else if ($handshake == "GBXRemote 2") {
			$this->protocol = 2;
		} else {
            $this->error = new IXR_Error(-32300, 'transport error - wrong lowlevel protocol version');
            return false;
		} 
		return true;
    }

    function Init($port) {
		return $this->InitWithIp("localhost", $port);
    }

	function Terminate() {
		if ($this->socket) {
			fclose($this->socket);
			$this->socket = false;
		}
	}

    function query() {
        $args = func_get_args();
        $method = array_shift($args);

        if (!$this->socket || $this->protocol == 0) {
            $this->error = new IXR_Error(-32300, 'transport error - Client not initialized.');
            return false;
        }
		
        $request = new IXR_Request($method, $args);
        $xml = $request->getXml();

		// send request
		$this->reqhandle ++;
		if ($this->protocol == 1) {
			$request = pack("Va*", strlen($xml), $xml);
		} else {
			$request = pack("VVa*", strlen($xml), $this->reqhandle, $xml);
		}
                fwrite($this->socket, $request);

		$contents = "";
		$contents_length = 0;
		do {
			$size = 0;
			$recvhandle = 0;
			// Get result
			if ($this->protocol == 1) {
				$array_result = unpack("Vsize", fread($this->socket, 4));
				$size = $array_result["size"];
				$recvhandle = $this->reqhandle;
			} else {
				$array_result = unpack("Vsize/Vhandle", fread($this->socket, 8));
				$size = $array_result["size"];
				$recvhandle = $array_result["handle"];
			}

			if ($recvhandle == 0 || $size == 0 || $size > 256*1024) {
				$this->error = new IXR_Error(-32700, 'transport error - connection interrupted.');
				return false;
			}

			$contents = "";
			$contents_length = 0;
			while ($contents_length < $size) {
				$contents .= fread($this->socket, $size-$contents_length);
				$contents_length = strlen($contents);
			}

			if (($recvhandle & 0x80000000) == 0) {
				// this is a callback, not our answer! handle= $recvhandle, xml-prc= $contents
				// just add it to the message list for the user to read.
				$new_cb_message = new IXR_Message($contents);
				if ($new_cb_message->parse() && $new_cb_message->messageType != 'fault') {
					array_push($this->cb_message, array($new_cb_message->methodName,$new_cb_message->params));
				}
			}
		} while((int)$recvhandle != (int)$this->reqhandle);

        $this->message = new IXR_Message($contents);
        if (!$this->message->parse()) {
            // XML error
            $this->error = new IXR_Error(-32700, 'parse error. not well formed');
            return false;
        }
        // Is the message a fault?
        if ($this->message->messageType == 'fault') {
            $this->error = new IXR_Error($this->message->faultCode, $this->message->faultString);
            return false;
        }
        // Message must be OK
        return true;
    }

	function readCB($timeout) {
		if (!$this->socket || $this->protocol == 0) {
			$this->error = new IXR_Error(-32300, 'transport error - Client not initialized.');
			return false;
		}
		if ($this->protocol == 1)
			return false;

		$something_received = false;
		$contents = "";
		$contents_length = 0;
		while (stream_select($read = array($this->socket), $write = NULL, $except = array($this->socket), $timeout)>0) {
			$timeout = 0;	// we don't want to wait for the full time again. just flush the available data.

			$size = 0;
			$recvhandle = 0;
			// Get result
			$array_result = unpack("Vsize/Vhandle", fread($this->socket, 8));
			$size = $array_result["size"];
			$recvhandle = $array_result["handle"];

			if ($recvhandle == 0 || $size == 0 || $size > 256*1024) {
				$this->error = new IXR_Error(-32700, 'transport error - connection interrupted.');
				return false;
			}
			if ($size > 512*1024) {
				$this->error = new IXR_Error(-32700, 'transport error - answer too big.');
				return false;
			}

			$contents = "";
			$contents_length = 0;
			while ($contents_length < $size) {
				$contents .= fread($this->socket, $size-$contents_length);
				$contents_length = strlen($contents);
			}

			if (($recvhandle & 0x80000000) == 0) {
				// (note) this is a callback, not our answer! handle= $recvhandle, xml-prc= $contents
				//echo "CALLBACK(".$contents_length.")[ ".$contents." ]\n";
				$new_cb_message = new IXR_Message($contents);
				if ($new_cb_message->parse() && $new_cb_message->messageType != 'fault') {
					array_push($this->cb_message, array($new_cb_message->methodName,$new_cb_message->params));
				}
				$something_received = false;
			}
		};

		return $something_received;
	}

    function getResponse() {
        // methodResponses can only have one param - return that
        return $this->message->params[0];
    }

    function getCBResponses() {
		// (look at the end of basic.php for an example)
		$messages = $this->cb_message;
		$this->cb_message = array();
		return $messages;
    }

    function isError() {
        return (is_object($this->error));
    }

    function getErrorCode() {
        return $this->error->code;
    }

    function getErrorMessage() {
        return $this->error->message;
    }
}


class IXR_ClientMulticall_Gbx extends IXR_Client_Gbx {
    var $calls = array();

    function addCall() {
        $args = func_get_args();
        $methodName = array_shift($args);
        $struct = array(
            'methodName' => $methodName,
            'params' => $args
        );
        $this->calls[] = $struct;
    }

    function query() {
        // Prepare multicall, then call the parent::query() method
        $result = parent::query('system.multicall', $this->calls);
		$this->calls = array();	// reset for next calls.
		return $result;
    }
}


?>