// Implementation of GbxRemote protocol.
// ----------------------------------------------------------------

using System;
//using System.Collections.Generic;
using System.Text;
using System.IO;
using System.Net;
using System.Net.Sockets;

namespace CookComputing.XmlRpc
{
	// add support for simple socket connection
	class XmlRpcSocketStream : Stream
	{
		public string Url
		{
			get { return m_Url; }
			set 
			{
				if (value != m_Url) {
					Close();
					m_Url = value;
				}
			}
		}
		
		public XmlRpcSocketStream() 
			: this("127.0.0.1", 5000)
		{
		}

		public XmlRpcSocketStream(string _Address, int _Port)
			: this("gbx://" + _Address + ":" + _Port)
		{
		}

		public XmlRpcSocketStream(string _Url)
		{
			m_Protocol = 0;
			m_Url = _Url;
			GameConnectAndHello(m_Url);
		}

		public void GameConnectAndHello(string _Url)
		{
			if ((m_Socket != null) && (m_Socket.Connected))
				return;

			Socket s = null;
			IPHostEntry hostEntry = null;

			Uri ServerUri = new Uri(_Url);
			if (String.Compare(ServerUri.Scheme, "gbx") != 0) {
				return;
			}
			
			// Get host related information.
			hostEntry = Dns.Resolve(ServerUri.Host);
			foreach (IPAddress address in hostEntry.AddressList)
			{
				IPEndPoint ipe = new IPEndPoint(address, ServerUri.Port);
				Socket tempSocket =
					new Socket(ipe.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
				try
				{
					tempSocket.Connect(ipe);
				}
				catch
				{
					continue;
				}

				if (tempSocket.Connected)
				{
					s = tempSocket;
					m_Socket = s;
					break;
				}
				else
					continue;
			}
			if (m_Socket != null && m_Socket.Connected)
				ReadHello();
			m_Url  = _Url;
		}

		public override bool CanRead
		{
			get { return true; }
		}

		public override bool CanSeek
		{
			get { return false; }
		}

		public override bool CanWrite
		{
			get { return true; }
		}

		public override long Length
		{
			get { throw new NotImplementedException(); }
		}

		public override long Position
		{
			get
			{
				throw new NotImplementedException();
			}
			set
			{
				throw new NotImplementedException();
			}
		}

		public override long Seek(long offset, SeekOrigin origin)
		{
			throw new NotImplementedException();
		}

		public override void SetLength(long value)
		{
			throw new NotImplementedException();
		}

		public int GetNextSize()
		{
			if (m_Socket != null && m_Socket.Connected)
			{
				byte[] buffer = new byte[4];
				int Bytes = Read(buffer, 0, buffer.Length);
				return System.BitConverter.ToInt32(buffer, 0);
			}
			else
				return 0;
		}
		
		public int GetNextHandle()
		{
			if (m_Socket != null && m_Socket.Connected)
			{
				byte[] buffer = new byte[4];
				int Bytes = Read(buffer, 0, buffer.Length);
				return System.BitConverter.ToInt32(buffer, 0);
			}
			else
				return 0;
		}
		
		public string GetNextMessage(int _Size)
		{
			if (m_Socket != null && m_Socket.Connected)
			{
				byte[] buffer = new byte[_Size];
				int Bytes = Read(buffer, 0, buffer.Length);
				return Encoding.UTF8.GetString(buffer);
			}
			else
				return "";
		}

		public string GetMessage()
		{
			if (m_Socket == null  || !m_Socket.Connected)
			{
				GameConnectAndHello(m_Url);
			}

			int Size = GetNextSize();
			if (m_Protocol >= 2) {
				int Handle = GetNextHandle();
			}
			return GetNextMessage(Size);
		}

		public void ReadHello()
		{
			string Version = GetNextMessage(GetNextSize());
			if (Version == "GBXRemote 1") {
				m_Protocol = 1;
			} else if (Version == "GBXRemote 2") {
				m_Protocol = 2;				
			} else {
				m_Protocol = 0;				
				m_ErrorMessage += "Wrong version !\n";
			}
		}

		public override int Read(byte[] buffer, int Offset, int Count)
		{
			if (m_Socket != null && m_Socket.Connected)
			{
				int Len = Count;
				while (Len > 0) 
				{
					int LenRecv = m_Socket.Receive(buffer, Offset, Len, SocketFlags.None);
					Len -= LenRecv;
					Offset += LenRecv;
				}
				return Count;
			}
			else 
				return 0;
		}

		public void SendHeader(int _size, int _handle)
		{
			if (m_Socket == null || !m_Socket.Connected)
			{
				GameConnectAndHello(m_Url);
			}
			if (m_Socket != null && m_Socket.Connected)
			{
				byte[] buffer;
				buffer = System.BitConverter.GetBytes(_size);
				m_Socket.Send(buffer);
				if (m_Protocol >= 2) {
					buffer = System.BitConverter.GetBytes(_handle);
					m_Socket.Send(buffer);
				}
			}
		}

		public override void Write(byte[] buffer, int offset, int count)
		{
			if (m_IsWriting)
			{
				byte[] TempBuffer = (byte[])m_Buffer.Clone();
				m_Buffer = new byte[TempBuffer.Length + count];
				for (int iBuff = 0; iBuff < TempBuffer.Length; iBuff++)
					m_Buffer[iBuff] = TempBuffer[iBuff];
				for (int iBuff = offset; iBuff < offset + count; iBuff++)
					m_Buffer[TempBuffer.Length + iBuff - offset] = buffer[iBuff];
			}
			else
			{
				m_IsWriting = true;
				m_Buffer = new byte[count];
				for (int iBuf = offset; iBuf < count; iBuf++)
					m_Buffer[iBuf] = buffer[iBuf];
			}
		}

		public override void Flush()
		{
			if (!m_IsWriting)
				return; // nothing to send

			if (m_Socket == null || !m_Socket.Connected)
			{
				GameConnectAndHello(m_Url);
			}
			
			/*if (m_Socket != null && (!m_Socket.Connected)) C#2.0
				m_Socket.Listen();*/
			if (m_Socket != null && m_Socket.Connected)
			{
				int handle = -1;
				SendHeader(m_Buffer.Length, handle);
				int Offset = 0;
				int Len = m_Buffer.Length;
				while (Len > 0) 
				{
					int LenSent = m_Socket.Send(m_Buffer, Offset, Len, SocketFlags.None);
					Len -= LenSent;
					Offset += LenSent;
				}
				m_IsWriting = false;
			}
		}

		public override void Close()
		{
			if (m_Socket != null)
			{
				//m_Socket.Disconnect(false); C#2.0
				//m_Socket.Shutdown();//Close();
				m_Socket = null;
			}
		}

		// Datas

		public string m_Url;

		public Socket	m_Socket;
		public bool m_IsWriting = false;
		public byte[] m_Buffer;
		
		public string m_ErrorMessage;
		public int m_Protocol;
	}
}
