// Exercises the real enrollment form handlers with an injected synthetic prompt.
// Never shows a form, calls CredUI, accesses a vault entry or opens a connection.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

class HubVaultEnrollmentFixture {
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  static readonly MethodInfo ClickMethod=typeof(Button).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic);
  static void Require(bool value,string code="ENROLLMENT_FIXTURE_ASSERTION_FAILED") {if(!value)throw new InvalidOperationException(code);}
  static void Click(Button button) {ClickMethod.Invoke(button,new object[]{EventArgs.Empty});}
  static int Count(List<string> events,string value) {int count=0;foreach(string item in events)if(item==value)count++;return count;}

  [STAThread]
  static int Main(string[] args) {
    byte[] synthetic=null;
    try {
      Require(args.Length==1);
      string mode=args[0];int promptCalls=0;bool validOwner=false;
      var events=new List<string>();var expected=new InvalidOperationException("SYNTHETIC_PROMPT_FAILED");
      synthetic=Encoding.UTF8.GetBytes("  Synthetic enrollment fixture \u7e41\u9ad4 \ud83d\udd10  ");
      HubSshEnrollmentWindow window=null;
      Func<IntPtr,byte[]> prompt=delegate(IntPtr owner) {
        promptCalls++;
        Require(window!=null&&!window.Visible);
        validOwner=owner!=IntPtr.Zero&&owner==window.Handle&&IsWindow(owner);
        Require(validOwner);
        Require(!window.StartButton.Enabled&&window.Started);
        if(mode=="failure")throw expected;
        return synthetic;
      };
      Action<string> eventSink=delegate(string value) {events.Add(value);if(mode=="event-failure"&&value=="ENROLLMENT_REQUESTED")throw expected;};
      using(window=new HubSshEnrollmentWindow("192.0.2.25:22","fixture",prompt,eventSink)) {
        Require(!window.Visible&&promptCalls==0&&!window.Started&&window.Secret==null);
        Require(Count(events,"ENROLLMENT_REQUESTED")==0);
        if(mode=="construction") {
          // An owner HWND alone must not start enrollment either.
          Require(window.Handle!=IntPtr.Zero&&!window.Visible&&promptCalls==0&&!window.Started);
        } else if(mode=="cancel") {
          Click(window.CancelButtonControl);
          Require(promptCalls==0&&!window.Started&&window.Secret==null);
          Require(Count(events,"ENROLLMENT_REQUESTED")==0);
        } else if(mode=="success"||mode=="failure"||mode=="event-failure") {
          Click(window.StartButton);
          // Force the handler a second time, even though the button is disabled.
          // This verifies the once-only guard rather than relying on UI state.
          Click(window.StartButton);
          Require(window.Started&&Count(events,"ENROLLMENT_REQUESTED")==1);
          Require(promptCalls==(mode=="event-failure"?0:1));
          if(mode=="success") {
            Require(validOwner,"SUCCESS_OWNER_INVALID");
            Require(window.Failure==null,"SUCCESS_RETURNED_FAILURE");
            Require(window.Secret!=null,"SUCCESS_BUFFER_MISSING");
            Require(window.Secret.Length==synthetic.Length,"SUCCESS_BUFFER_LENGTH_CHANGED");
            for(int i=0;i<synthetic.Length;i++)Require(window.Secret[i]==synthetic[i],"SUCCESS_BUFFER_BYTES_CHANGED");
          } else Require(Object.ReferenceEquals(window.Failure,expected)&&window.Secret==null);
        } else throw new InvalidOperationException("ENROLLMENT_FIXTURE_MODE_REJECTED");
      }
      if(mode=="success") {
        Require(window.Secret==null,"DISPOSE_RETAINED_BUFFER_REFERENCE");
        foreach(byte item in synthetic)Require(item==0,"DISPOSE_DID_NOT_CLEAR_OWNED_BUFFER");
      }
      Console.WriteLine("{\"ok\":true,\"syntheticPromptCalls\":"+promptCalls+",\"requestedEvents\":"+Count(events,"ENROLLMENT_REQUESTED")+",\"ownerHandleVerified\":"+(validOwner?"true":"false")+",\"visibleWindows\":0,\"nativeCredUiCalls\":0,\"vaultCalls\":0,\"sshCalls\":0}");
      return 0;
    } catch(Exception error) {
      string code=error is InvalidOperationException?error.Message:error.GetType().Name.ToUpperInvariant();
      Console.Error.WriteLine("ENROLLMENT_FIXTURE_FAILED:"+code);return 1;
    } finally {if(synthetic!=null)Array.Clear(synthetic,0,synthetic.Length);}
  }
}
